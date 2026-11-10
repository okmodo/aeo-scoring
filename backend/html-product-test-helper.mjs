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
                function walk(node) {
                    if (node.nodeName === '#text') {
                        const width = self.chunkSize || node.value.length || 1;
                        for (let offset = 0; offset < node.value.length; offset += width)
                            self.document?.text?.({ text: node.value.slice(offset, offset + width) });
                        return;
                    }
                    let end;
                    if (node.tagName)
                        self.handlers.get('*')?.element?.({ tagName: node.tagName, attributes: node.attrs.map(a => [a.name, a.value]), getAttribute(name) { return node.attrs.find(a => a.name === name)?.value ?? null; }, onEndTag(fn) { end = fn; } });
                    for (const child of node.childNodes || [])
                        walk(child);
                    end?.();
                }
                walk(parse(html));
                controller.enqueue(new TextEncoder().encode(html));
                controller.close();
            } }));
    }
}
