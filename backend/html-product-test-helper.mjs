import { parse } from 'parse5';
// Test adapter: parse5 supplies real HTML parsing while production uses native HTMLRewriter.
export class HtmlTestRewriter {
    handlers = new Map();
    document = null;
    chunkSize = 0;
    on(selector, handler) { this.handlers.set(selector, handler); return this; }
    onDocument(handler) { this.document = handler; return this; }
    transform(response) {
        const self = this;
        return new Response(new ReadableStream({ async start(controller) {
                const html = await response.text();
                function walk(node, textHandler = null) {
                    if (node.nodeName === '#text') {
                        const width = self.chunkSize || node.value.length || 1;
                        for (let offset = 0; offset < node.value.length; offset += width) {
                            const chunk = { text: node.value.slice(offset, offset + width) };
                            self.document?.text?.(chunk);
                            textHandler?.(chunk);
                        }
                        return;
                    }
                    let end;
                    if (node.tagName) {
                        const element = { tagName: node.tagName, attributes: node.attrs.map(a => [a.name, a.value]), getAttribute(name) { return node.attrs.find(a => a.name === name)?.value ?? null; }, onEndTag(fn) { end = fn; } };
                        self.handlers.get('*')?.element?.(element);
                        if (node.tagName === 'link' && element.getAttribute('rel') !== null)
                            self.handlers.get('link[rel]')?.element?.(element);
                        if (node.tagName === 'script' && element.getAttribute('type') === 'application/ld+json') {
                            const handler = self.handlers.get('script[type="application/ld+json"]');
                            handler?.element?.(element);
                            textHandler = handler?.text;
                        }
                    }
                    for (const child of node.childNodes || [])
                        walk(child, textHandler);
                    end?.();
                }
                walk(parse(html));
                controller.enqueue(new TextEncoder().encode(html));
                controller.close();
            } }));
    }
}
