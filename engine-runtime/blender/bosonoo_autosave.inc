/* SPDX-License-Identifier: GPL-3.0-or-later
 * Bosonoo browser adapter, included inside Blender's namespace in wm_files.cc.
 * Only an immutable /bosonoo/workspace/<name>.blend is admitted. No operator
 * names, Python source, arbitrary paths, or callbacks cross this interface.
 * Browser calls publish requests; serialization runs on Blender's event thread.
 */
static std::atomic<int> g_bosonoo_enabled{0};
static std::atomic<int> g_bosonoo_status{0};
static std::atomic<bool> g_bosonoo_requested{false};
static char g_bosonoo_path[FILE_MAX] = {0};
static bool g_bosonoo_had_project = false; /* Accessed only by Blender's event thread. */

extern "C" EMSCRIPTEN_KEEPALIVE int blender_bosonoo_autosave_enable(const char *path)
{
  if (path == nullptr || g_bosonoo_enabled.load() != 0) {
    return 0;
  }
  const char *prefix = "/bosonoo/workspace/";
  const size_t prefix_len = strlen(prefix);
  const size_t length = strlen(path);
  if (length >= sizeof(g_bosonoo_path) || length <= prefix_len + 6 ||
      strncmp(path, prefix, prefix_len) != 0) {
    return 0;
  }
  const char *name = path + prefix_len;
  if (name[0] == '.' || strchr(name, '/') || strchr(name, '\\') ||
      !BLI_strcaseeq(path + length - 6, ".blend")) {
    return 0;
  }
  int expected = 0;
  if (!g_bosonoo_enabled.compare_exchange_strong(expected, -1)) {
    return 0;
  }
  BLI_strncpy(g_bosonoo_path, path, sizeof(g_bosonoo_path));
  g_bosonoo_status.store(1);
  g_bosonoo_enabled.store(1);
  return 1;
}

/* 0 disabled, 1 loading, 2 clean, 3 dirty, 4 busy, 5 requested, 6 failed,
 * 7 the loaded document/window changed after the original project was ready.
 * A clean native file is not a cloud receipt: the JS provider/ledger handles that.
 */
extern "C" EMSCRIPTEN_KEEPALIVE int blender_bosonoo_autosave_status()
{
  return g_bosonoo_status.load();
}

extern "C" EMSCRIPTEN_KEEPALIVE int blender_bosonoo_save_current()
{
  if (g_bosonoo_enabled.load() != 1) {
    return 0;
  }
  g_bosonoo_requested.store(true);
  return 1;
}

static void wm_bosonoo_autosave_poll(bContext *C)
{
  if (g_bosonoo_enabled.load() != 1) {
    return;
  }
  Main *bmain = CTX_data_main(C);
  wmWindowManager *wm = CTX_wm_manager(C);
  if (bmain == nullptr || wm == nullptr || BLI_listbase_is_empty(&wm->windows) ||
      strcmp(BKE_main_blendfile_path(bmain), g_bosonoo_path) != 0) {
    g_bosonoo_status.store(g_bosonoo_had_project ? 7 : 1);
    return;
  }
  g_bosonoo_had_project = true;
  /* Use the native autosave safety fence: editing modal operations can contain
   * partial, uncommitted scene state. Keep the request pending until they end.
   */
  for (wmWindow &win : wm->windows) {
    for (wmEventHandler &handler_base : win.runtime->modalhandlers) {
      if (handler_base.type == WM_HANDLER_TYPE_OP &&
          reinterpret_cast<wmEventHandler_Op *>(&handler_base)->op) {
        g_bosonoo_status.store(wm->file_saved ? 2 : 4);
        return;
      }
    }
  }
  if (wm->file_saved) {
    g_bosonoo_requested.store(false);
    g_bosonoo_status.store(2);
    return;
  }
  if (!g_bosonoo_requested.exchange(false)) {
    if (g_bosonoo_status.load() != 6) {
      g_bosonoo_status.store(3);
    }
    return;
  }
  g_bosonoo_status.store(5);
  ED_editors_flush_edits(bmain);
  ED_image_internal_autosave_flush(bmain);
  BlendFileWriteParams params{};
  /* Native serialization, without operator invocation or Python save handlers.
   * The normal writer stages '<name>@' then renames it atomically. Provider 7
   * observes only that final rename and submits the one-file save ledger.
   */
  const int flags = (G.fileflags | G_FILE_COMPRESS) & ~G_FILE_RECOVER_WRITE;
  const bool success = BLO_write_file(bmain, g_bosonoo_path, flags, &params, &wm->runtime->reports);
  if (success) {
    wm->file_saved = 1;
    WM_main_add_notifier(NC_WM | ND_DATACHANGED, nullptr);
  }
  g_bosonoo_status.store(success ? 2 : 6);
}
