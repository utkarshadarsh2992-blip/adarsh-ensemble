// Browsers ignore frame-ancestors in a meta element. Keep this defense for static hosting
// until the publish layer emits the equivalent response header.
if (window.top !== window.self) {
  window.top?.location.replace(window.location.href);
}
