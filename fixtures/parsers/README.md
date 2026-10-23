# Parser fixtures

Synthetic inputs for the parser tests in `packages/core/src/parsers` (#43). Nothing here is a real document.

- `scan-lorem.pgm`: an 8-bit greyscale image (417 x 89) of the placeholder words "Lorem ipsum dolor" in 28 pt Helvetica, standing in for a scanned page. It was made by rendering a one-line PDF (`BT /F1 28 Tf 12 22 Td (Lorem ipsum dolor) Tj ET` on a 300 x 64 pt page) with poppler: `pdftoppm -gray -r 100 -singlefile page.pdf scan-lorem`. The OCR test reads it directly and also wraps it in a PDF with no text layer.
