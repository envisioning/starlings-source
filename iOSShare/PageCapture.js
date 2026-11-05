// Safari runs this in the shared page before the share sheet opens
// (NSExtensionJavaScriptPreprocessingFile). It hands the extension the
// page's address, title and HTML, as Safari drew it for its reader.
//
// It works on a copy: the page the person is reading stays untouched. The
// copy loses what the Worker's reader ignores, as web/src/page-capture.ts
// does for the bookmarklet, and keeps the JSON-LD.
var PageCapture = function () {};

PageCapture.prototype = {
  run: function (args) {
    var copy = document.documentElement.cloneNode(true);
    var strip = copy.querySelectorAll(
      'script:not([type="application/ld+json"]), style, link, noscript, template, svg, canvas, iframe, object, embed, video, audio, source'
    );
    for (var i = 0; i < strip.length; i += 1) strip[i].remove();
    var styled = copy.querySelectorAll('[style]');
    for (var j = 0; j < styled.length; j += 1) styled[j].removeAttribute('style');
    args.completionFunction({
      url: document.URL,
      title: document.title,
      html: '<!doctype html>' + copy.outerHTML,
    });
  },
  finalize: function () {},
};

var ExtensionPreprocessingJS = new PageCapture();
