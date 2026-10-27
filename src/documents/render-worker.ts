import { PDFParse } from 'pdf-parse';
process.once('message', (input) => {
  void render(input as { bytes: Uint8Array; maxPages: number; maxVisual: number });
});
async function render({
  bytes,
  maxPages,
  maxVisual,
}: {
  bytes: Uint8Array;
  maxPages: number;
  maxVisual: number;
}) {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const info = await parser.getInfo({ parsePageInfo: true });
    if (info.total > maxPages || !info.total) throw new Error('DOCUMENT_TOO_MANY_PAGES');
    const count = Math.min(maxVisual, info.total);
    const selected = Array.from({ length: count }, (_, i) =>
      count === 1 ? 1 : 1 + Math.round((i * (info.total - 1)) / (count - 1)),
    );
    for (const p of info.pages.filter((p) => selected.includes(p.pageNumber)))
      if (
        !Number.isFinite(p.width) ||
        !Number.isFinite(p.height) ||
        p.width <= 0 ||
        p.height <= 0 ||
        p.height / p.width > 4 ||
        p.width / p.height > 4
      )
        throw new Error('DOCUMENT_VISUAL_LIMIT');
    const pages: { pageNumber: number; dataUrl: string }[] = [];
    let totalBytes = 0;
    for (const page of selected) {
      const image = (
        await parser.getScreenshot({
          partial: [page],
          desiredWidth: 1280,
          imageDataUrl: true,
          imageBuffer: false,
        })
      ).pages[0];
      if (!image?.dataUrl || image.width * image.height > 7_000_000)
        throw new Error('DOCUMENT_VISUAL_LIMIT');
      totalBytes += image.dataUrl.length;
      if (totalBytes > 16_000_000) throw new Error('DOCUMENT_VISUAL_LIMIT');
      pages.push({ pageNumber: page, dataUrl: image.dataUrl });
    }
    process.send?.({ pages, total: info.total });
  } catch (error) {
    process.send?.({
      error:
        error instanceof Error && /^DOCUMENT_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'DOCUMENT_RENDER_FAILED',
    });
  } finally {
    await parser.destroy();
  }
}
