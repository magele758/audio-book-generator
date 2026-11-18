export function createPlayer({ audio, bookId, chapters, onPosition }) {
  let index = -1;
  let segmentIndex = -1;
  let rate = 1;
  let playOnEnded = true;

  function loadSegment(chapterIndex, nextSegment) {
    if (!Array.isArray(chapters) || chapterIndex < 0 || chapterIndex >= chapters.length) return false;
    const segments = chapters[chapterIndex].segments || [];
    if (nextSegment < 0 || nextSegment >= segments.length) return false;
    index = chapterIndex;
    segmentIndex = nextSegment;
    const segment = segments[segmentIndex];
    audio.src = `/api/books/${bookId}/chapters/${chapters[index].id}/segments/${segment.id}/audio`;
    audio.playbackRate = rate;
    const position = {
      chapterIndex: index,
      segmentIndex,
      segmentCount: segments.length,
    };
    // False means the segment stays loaded, but ended must not call play().
    playOnEnded = onPosition?.(position) !== false;
    return true;
  }

  function load(nextIndex) {
    return loadSegment(nextIndex, 0);
  }

  function pause() {
    audio.pause();
  }

  function resume() {
    return audio.play();
  }

  function progress() {
    const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    return { currentTime, duration };
  }

  function next() {
    return load(index + 1);
  }

  function previous() {
    return load(index - 1);
  }

  function stepSegment(delta) {
    if (!Number.isInteger(delta) || delta === 0) return false;
    if (!Array.isArray(chapters) || index < 0 || index >= chapters.length) return false;
    const direction = delta > 0 ? 1 : -1;
    let chapterIndex = index;
    let segIndex = segmentIndex;
    for (let step = 0; step < Math.abs(delta); step += 1) {
      const segments = chapters[chapterIndex].segments || [];
      const within = segIndex + direction;
      if (within >= 0 && within < segments.length) {
        segIndex = within;
        continue;
      }
      const neighbor = chapterIndex + direction;
      if (neighbor < 0 || neighbor >= chapters.length) return false;
      const neighborSegments = chapters[neighbor].segments || [];
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

  audio.addEventListener('ended', () => {
    if (index < 0) return;
    const segments = chapters[index].segments || [];
    const advanced = segmentIndex + 1 < segments.length
      ? loadSegment(index, segmentIndex + 1)
      : load(index + 1);
    if (!advanced || !playOnEnded) return;
    const pending = resume();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  });

  return {
    load,
    pause,
    resume,
    progress,
    next,
    previous,
    stepSegment,
    setRate,
    get index() {
      return index;
    },
    get segmentIndex() {
      return segmentIndex;
    },
  };
}
