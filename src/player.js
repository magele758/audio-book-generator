export function createPlayer({
  audio,
  bookId,
  chapters,
  onPosition,
  onWaiting,
  onError,
  prefetch = false,
  fetchImpl = globalThis.fetch,
}) {
  let currentChapters = Array.isArray(chapters) ? chapters : [];
  let index = -1;
  let segmentIndex = -1;
  let rate = 1;
  let playOnEnded = true;
  let playGeneration = 0;
  let desired = 'paused';
  let waiting = false;
  let pendingSeekTime = 0;
  let destroyed = false;
  let currentAudioUrl = '';

  const prefetched = new Map();
  const inflight = new Map();

  function isSegmentReady(segment) {
    return Boolean(segment) && (!segment.audio || segment.audio.status === 'ready');
  }

  function segmentUrl(chapter, segment) {
    return `/api/books/${bookId}/chapters/${chapter.id}/segments/${segment.id}/audio`;
  }

  function revokeUrl(blobUrl) {
    try {
      globalThis.URL?.revokeObjectURL?.(blobUrl);
    } catch {
      // Ignore revoke failures
    }
  }

  function evictOldest(keepUrl) {
    while (prefetched.size > 4) {
      let victimKey = null;
      for (const key of prefetched.keys()) {
        if (key !== keepUrl) {
          victimKey = key;
          break;
        }
      }
      if (!victimKey) break;
      const entry = prefetched.get(victimKey);
      prefetched.delete(victimKey);
      if (entry?.blobUrl) revokeUrl(entry.blobUrl);
    }
  }

  function prefetchUrl(url) {
    if (!prefetch || destroyed) return;
    if (typeof fetchImpl !== 'function' || typeof globalThis.URL?.createObjectURL !== 'function') return;
    if (prefetched.has(url) || inflight.has(url)) return;
    const task = Promise.resolve()
      .then(() => fetchImpl(url))
      .then(async (res) => {
        if (!res?.ok || destroyed) return;
        const blob = await res.blob();
        if (destroyed) return;
        const blobUrl = globalThis.URL.createObjectURL(blob);
        if (destroyed) {
          revokeUrl(blobUrl);
          return;
        }
        prefetched.set(url, { blobUrl });
        evictOldest(currentAudioUrl);
      })
      .catch(() => {})
      .finally(() => {
        inflight.delete(url);
      });
    inflight.set(url, task);
  }

  function prefetchAhead(fromChapter, fromSegment) {
    if (!prefetch || destroyed || !Array.isArray(currentChapters) || fromChapter < 0) return;
    let chIdx = fromChapter;
    let segIdx = fromSegment;
    let found = 0;
    while (found < 2 && chIdx < currentChapters.length) {
      const segments = currentChapters[chIdx]?.segments || [];
      segIdx += 1;
      if (segIdx >= segments.length) {
        chIdx += 1;
        segIdx = -1;
        continue;
      }
      const candidate = segments[segIdx];
      if (!isSegmentReady(candidate)) break;
      prefetchUrl(segmentUrl(currentChapters[chIdx], candidate));
      found += 1;
    }
  }

  function applyPendingSeek() {
    if (!(pendingSeekTime > 0)) return;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      const target = Math.min(pendingSeekTime, Math.max(0, audio.duration - 0.15));
      audio.currentTime = target;
      pendingSeekTime = 0;
    }
  }

  function resolvedSrcFor(url) {
    if (prefetch && prefetched.has(url)) {
      return prefetched.get(url).blobUrl;
    }
    return url;
  }

  function loadSegment(chapterIndex, nextSegment, options = {}) {
    if (!Array.isArray(currentChapters) || chapterIndex < 0 || chapterIndex >= currentChapters.length) return false;
    const chapter = currentChapters[chapterIndex];
    const segments = chapter.segments || [];
    if (nextSegment < 0 || nextSegment >= segments.length) return false;
    index = chapterIndex;
    segmentIndex = nextSegment;
    const segment = segments[segmentIndex];
    const position = {
      chapterIndex: index,
      segmentIndex,
      segmentCount: segments.length,
    };
    const startTime = Number(options?.startTime);
    pendingSeekTime = Number.isFinite(startTime) && startTime > 0 ? startTime : 0;

    if (!isSegmentReady(segment)) {
      pendingSeekTime = 0;
      waiting = true;
      desired = 'paused';
      playOnEnded = false;
      playGeneration += 1;
      audio.pause?.();
      onPosition?.(position);
      onWaiting?.(position);
      return false;
    }
    waiting = false;
    const url = segmentUrl(chapter, segment);
    currentAudioUrl = url;
    audio.src = resolvedSrcFor(url);
    audio.playbackRate = rate;
    if (pendingSeekTime > 0 && audio.readyState >= 1) {
      applyPendingSeek();
    }
    // False means the segment stays loaded, but ended must not call play().
    playOnEnded = onPosition?.(position) !== false;
    prefetchAhead(index, segmentIndex);
    return true;
  }

  function load(nextIndex) {
    return loadSegment(nextIndex, 0);
  }

  function pause() {
    desired = 'paused';
    waiting = false;
    playGeneration += 1;
    audio.pause();
  }

  function resume() {
    const chapter = Array.isArray(currentChapters) ? currentChapters[index] : null;
    const segments = chapter?.segments || [];
    const segment = segments[segmentIndex];
    if (!segment || !isSegmentReady(segment)) {
      waiting = true;
      desired = 'paused';
      if (index >= 0 && segmentIndex >= 0) {
        onWaiting?.({
          chapterIndex: index,
          segmentIndex,
          segmentCount: segments.length,
        });
      }
      return Promise.resolve();
    }
    if (waiting || audio.error || !audio.src) {
      const url = segmentUrl(chapter, segment);
      currentAudioUrl = url;
      audio.src = resolvedSrcFor(url);
      audio.load?.();
      waiting = false;
    }
    if (pendingSeekTime > 0 && audio.readyState >= 1) {
      applyPendingSeek();
    }
    audio.playbackRate = rate;
    desired = 'playing';
    const generation = ++playGeneration;
    const pending = audio.play();
    // A play() that resolves after pause() must not start the audio again.
    if (pending && typeof pending.then === 'function') {
      pending.then(() => {
        if (generation !== playGeneration) audio.pause();
      }, (error) => {
        if (generation === playGeneration) {
          desired = 'paused';
          onError?.(error);
        }
      });
    }
    prefetchAhead(index, segmentIndex);
    return pending;
  }

  function progress() {
    const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    return {
      currentTime: pendingSeekTime > 0 && !(currentTime > 0) ? pendingSeekTime : currentTime,
      duration,
    };
  }

  function next() {
    return load(index + 1);
  }

  function previous() {
    return load(index - 1);
  }

  function stepSegment(delta) {
    if (!Number.isInteger(delta) || delta === 0) return false;
    if (!Array.isArray(currentChapters) || index < 0 || index >= currentChapters.length) return false;
    const direction = delta > 0 ? 1 : -1;
    let chapterIndex = index;
    let segIndex = segmentIndex;
    for (let step = 0; step < Math.abs(delta); step += 1) {
      const segments = currentChapters[chapterIndex].segments || [];
      const within = segIndex + direction;
      if (within >= 0 && within < segments.length) {
        segIndex = within;
        continue;
      }
      const neighbor = chapterIndex + direction;
      if (neighbor < 0 || neighbor >= currentChapters.length) return false;
      const neighborSegments = currentChapters[neighbor].segments || [];
      if (neighborSegments.length === 0) return false;
      chapterIndex = neighbor;
      segIndex = direction > 0 ? 0 : neighborSegments.length - 1;
    }
    return loadSegment(chapterIndex, segIndex);
  }

  function setRate(nextRate) {
    if (!Number.isFinite(nextRate) || nextRate <= 0) return;
    rate = nextRate;
    audio.playbackRate = rate;
  }

  function updateChapters(nextChapters) {
    if (Array.isArray(nextChapters)) currentChapters = nextChapters;
    if (index >= 0 && segmentIndex >= 0) prefetchAhead(index, segmentIndex);
  }

  function reloadCurrent() {
    if (index < 0 || segmentIndex < 0) return false;
    return loadSegment(index, segmentIndex);
  }

  function onEnded() {
    if (index < 0) return;
    const segments = currentChapters[index]?.segments || [];
    const advanced = segmentIndex + 1 < segments.length
      ? loadSegment(index, segmentIndex + 1)
      : load(index + 1);
    if (!advanced) {
      if (!waiting) desired = 'paused';
      return;
    }
    if (!playOnEnded) return;
    const pending = resume();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  }

  function onLoadedMetadata() {
    audio.playbackRate = rate;
    applyPendingSeek();
  }

  function destroy() {
    destroyed = true;
    audio.removeEventListener?.('ended', onEnded);
    audio.removeEventListener?.('loadedmetadata', onLoadedMetadata);
    for (const entry of prefetched.values()) {
      if (entry?.blobUrl) revokeUrl(entry.blobUrl);
    }
    prefetched.clear();
    inflight.clear();
  }

  audio.addEventListener('ended', onEnded);
  audio.addEventListener('loadedmetadata', onLoadedMetadata);

  return {
    load,
    loadSegment,
    pause,
    resume,
    progress,
    next,
    previous,
    stepSegment,
    setRate,
    updateChapters,
    reloadCurrent,
    destroy,
    get index() {
      return index;
    },
    get segmentIndex() {
      return segmentIndex;
    },
    get playing() {
      return desired === 'playing';
    },
    get waiting() {
      return waiting;
    },
    get pendingSeek() {
      return pendingSeekTime;
    },
  };
}
