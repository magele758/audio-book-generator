const CLEAR_MESSAGE = '确定清空资料库中所有书籍的已生成音频吗？音频将被删除，无法撤销，需要重新生成。书籍、正文、播放进度和音色样本会保留。';

export async function confirmLibraryAudioClear(confirm, clear) {
  if (!confirm(CLEAR_MESSAGE)) return;
  await clear();
}
