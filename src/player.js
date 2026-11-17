export function chapterAudioUrl(bookId, chapterId) {
  return `/api/books/${bookId}/chapters/${chapterId}/audio`;
}

export function createPlayer({ audio, bookId, chapters, onChapter }) {
  let index = -1;

  function load(nextIndex) {
    if (!Array.isArray(chapters) || nextIndex < 0 || nextIndex >= chapters.length) return false;
    index = nextIndex;
    audio.src = chapterAudioUrl(bookId, chapters[index].id);
    onChapter?.(index);
    return true;
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

  audio.addEventListener('ended', () => {
    if (!next()) return;
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
    get index() {
      return index;
    },
  };
}
