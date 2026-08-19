export default defineBackground({
  persistent: true,
  main() {
    // All browser listener registration lives in this function so the
    // background page's full listener set is (re)established synchronously
    // on every load, which MV2 persistent background pages require.
    browser.runtime.onInstalled.addListener(() => {
      console.log("[agent] background installed");
    });
  },
});
