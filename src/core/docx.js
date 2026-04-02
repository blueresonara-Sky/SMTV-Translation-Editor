const fs = require("fs/promises");
const JSZip = require("jszip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const { hasPersian, normalizeWhitespace } = require("./utils");

const DOCUMENT_XML_PATH = "word/document.xml";

function localName(node) {
  return node?.localName || String(node?.nodeName || "").split(":").pop();
}

function childElements(node, name) {
  const matches = [];
  for (let current = node?.firstChild; current; current = current.nextSibling) {
    if (current.nodeType === 1 && localName(current) === name) {
      matches.push(current);
    }
  }
  return matches;
}

function descendantElements(node, name, list = []) {
  for (let current = node?.firstChild; current; current = current.nextSibling) {
    if (current.nodeType !== 1) {
      continue;
    }
    if (localName(current) === name) {
      list.push(current);
    }
    descendantElements(current, name, list);
  }
  return list;
}

function hasHighlightValue(node, acceptedValues) {
  const highlights = descendantElements(node, "highlight");
  return highlights.some((highlight) => {
    const value = highlight.getAttribute("w:val") || highlight.getAttribute("val") || "";
    return acceptedValues.has(value);
  });
}

function extractText(node) {
  let value = "";

  for (let current = node?.firstChild; current; current = current.nextSibling) {
    if (current.nodeType === 1) {
      const tag = localName(current);
      if (tag === "t") {
        value += current.textContent || "";
      } else if (tag === "tab") {
        value += "\t";
      } else if (tag === "br") {
        value += "\n";
      } else {
        value += extractText(current);
      }
    }
  }

  return normalizeWhitespace(value);
}

function findSubtitleTable(documentElement) {
  const tables = descendantElements(documentElement, "tbl");
  return (
    tables.find((table) => {
      const rows = childElements(table, "tr");
      return rows.some((row) => childElements(row, "tc").length === 3);
    }) || null
  );
}

function cloneTemplateParts(cell) {
  const firstParagraph = childElements(cell, "p")[0] || null;
  const firstRun = firstParagraph ? childElements(firstParagraph, "r")[0] || null : null;

  return {
    paragraphProperties: firstParagraph
      ? childElements(firstParagraph, "pPr")[0]?.cloneNode(true) || null
      : null,
    runProperties: firstRun ? childElements(firstRun, "rPr")[0]?.cloneNode(true) || null : null
  };
}

function clearCellContent(cell) {
  const removable = [];
  for (let current = cell.firstChild; current; current = current.nextSibling) {
    if (current.nodeType === 1 && localName(current) === "tcPr") {
      continue;
    }
    removable.push(current);
  }

  for (const node of removable) {
    cell.removeChild(node);
  }
}

function setCellText(cell, text) {
  const doc = cell.ownerDocument;
  const template = cloneTemplateParts(cell);
  clearCellContent(cell);

  const paragraph = doc.createElement("w:p");
  if (template.paragraphProperties) {
    paragraph.appendChild(template.paragraphProperties);
  }

  if (text) {
    const run = doc.createElement("w:r");
    if (template.runProperties) {
      run.appendChild(template.runProperties);
    }

    const textNode = doc.createElement("w:t");
    if (/^\s|\s$/.test(text)) {
      textNode.setAttribute("xml:space", "preserve");
    }
    textNode.appendChild(doc.createTextNode(text));
    run.appendChild(textNode);
    paragraph.appendChild(run);
  }

  cell.appendChild(paragraph);
}

async function loadDocxSubtitleDocumentFromBuffer(buffer, filePath = "memory.docx") {
  const zip = await JSZip.loadAsync(buffer);
  const xmlText = await zip.file(DOCUMENT_XML_PATH).async("text");
  const document = new DOMParser().parseFromString(xmlText, "application/xml");
  const table = findSubtitleTable(document.documentElement);

  if (!table) {
    throw new Error("Could not find a 3-column subtitle table in this document.");
  }

  const rows = [];
  const tableRows = childElements(table, "tr");
  for (let index = 0; index < tableRows.length; index += 1) {
    const rowElement = tableRows[index];
    const cells = childElements(rowElement, "tc");
    if (cells.length !== 3) {
      continue;
    }

    const englishText = extractText(cells[1]);
    const persianText = extractText(cells[2]);
    const hasGrayHighlight =
      hasHighlightValue(cells[1], new Set(["lightGray"])) ||
      hasHighlightValue(cells[2], new Set(["lightGray"]));
    rows.push({
      index: rows.length,
      rowNumber: index + 1,
      englishText,
      persianText,
      isBlankRow: !englishText && !persianText,
      hasPersian: hasPersian(persianText),
      hasGrayHighlight,
      persianCell: cells[2]
    });
  }

  return {
    filePath,
    zip,
    document,
    rows
  };
}

async function loadDocxSubtitleDocument(filePath) {
  const buffer = await fs.readFile(filePath);
  return loadDocxSubtitleDocumentFromBuffer(buffer, filePath);
}

async function saveDocxSubtitleDocument(model, outputPath, rewrittenRows) {
  const rewriteMap = new Map(rewrittenRows.map((row) => [row.rowNumber, row.persianText]));
  for (const row of model.rows) {
    if (!rewriteMap.has(row.rowNumber)) {
      continue;
    }
    setCellText(row.persianCell, rewriteMap.get(row.rowNumber));
  }

  const xml = new XMLSerializer().serializeToString(model.document);
  model.zip.file(DOCUMENT_XML_PATH, xml);
  const outputBuffer = await model.zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 }
  });
  await fs.writeFile(outputPath, outputBuffer);
}

module.exports = {
  loadDocxSubtitleDocument,
  loadDocxSubtitleDocumentFromBuffer,
  saveDocxSubtitleDocument
};
