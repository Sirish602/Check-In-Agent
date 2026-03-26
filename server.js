import express from "express";
import dotenv from "dotenv";
import multer from "multer";
import PDFDocument from "pdfkit";
import pdfParse from "pdf-parse";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function safeJsonParse(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

async function extractUploadedText(files = []) {
  const chunks = [];

  for (const file of files) {
    const original = file.originalname || "uploaded-file";
    const ext = path.extname(original).toLowerCase();

    if (ext === ".txt" || ext === ".md" || ext === ".csv") {
      chunks.push(`File: ${original}\n${file.buffer.toString("utf8")}`);
      continue;
    }

    if (ext === ".pdf") {
      try {
        const parsed = await pdfParse(file.buffer);
        chunks.push(`File: ${original}\n${parsed.text}`);
      } catch (err) {
        chunks.push(`File: ${original}\n[Could not extract PDF text: ${err.message}]`);
      }
      continue;
    }

    chunks.push(`File: ${original}\n[Unsupported file type for text extraction]`);
  }

  return chunks.filter(Boolean).join("\n\n---\n\n");
}

function buildPrompt(payload) {
  const {
    employee_name,
    role,
    quarter,
    questions,
    achievements,
    values,
    current_notes,
    prior_forms_text,
  } = payload;

  return `
You are an AI check-in assistant for a quarterly employee check-in.

Create a polished, professional check-in draft from the input data.
Use only the provided information plus careful, conservative wording.
Do not invent metrics, names, or facts.
If something is unclear, mark it for confirmation.

Return ONLY valid JSON with this shape:
{
  "title": "string",
  "summary": "string",
  "section_answers": [
    {
      "question": "string",
      "answer": "string",
      "evidence_used": ["string"],
      "needs_confirmation": ["string"]
    }
  ],
  "achievements": ["string"],
  "value_mappings": [
    {
      "value_name": "string",
      "evidence": "string",
      "impact": "string",
      "confidence": "High|Medium|Low"
    }
  ],
  "risks_or_gaps": ["string"],
  "needs_confirmation": ["string"],
  "compliance_notes": ["string"],
  "suggested_next_steps": ["string"],
  "source": "Azure OpenAI"
}

Context:
Employee name: ${employee_name || ""}
Role: ${role || ""}
Quarter: ${quarter || ""}
Questions: ${JSON.stringify(questions || [])}
Achievements: ${JSON.stringify(achievements || [])}
Values: ${JSON.stringify(values || [])}
Current notes: ${current_notes || ""}
Prior forms text: ${prior_forms_text || ""}
`;
}

async function callAzureOpenAI(messages) {
  const endpoint = 'https://gdc-content-ai.openai.azure.com';
  const deployment = 'gpt-4.1';
  const apiVersion = '2024-02-15-preview';
  const apiKey = 'bceeabc102464dbcb7b5b3c5f1bd9d5a';

  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  console.log("Azure request URL:", url);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      messages,
      temperature: 0.25,
      max_tokens: 1200,
      response_format: { type: "json_object" },
    }),
  });

  console.log("Azure response status:", response.status, response.statusText);

  const raw = await response.text();
  console.log("Azure raw response:", raw);

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Azure returned non-JSON response: ${err.message}`);
  }

  if (!response.ok) {
    const detail = data?.error?.message || JSON.stringify(data);
    throw new Error(`Azure request failed (${response.status}): ${detail}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Azure response did not include choices[0].message.content");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Assistant returned invalid JSON: ${err.message}`);
  }

  return parsed;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/draft", upload.array("prior_forms"), async (req, res) => {
  try {
    console.log("Incoming form fields:", req.body);
    console.log("Incoming file count:", req.files?.length || 0);

    const employee_name = cleanText(req.body.employee_name);
    const role = cleanText(req.body.role);
    const quarter = cleanText(req.body.quarter);
    const questions = safeJsonParse(req.body.questions, []);
    const achievements = safeJsonParse(req.body.achievements, []);
    const values = safeJsonParse(req.body.values, []);
    const current_notes = cleanText(req.body.current_notes);
    const prior_forms_text = await extractUploadedText(req.files || []);

    if (!employee_name) {
      return res.status(400).json({ error: "Employee name is required." });
    }

    const prompt = buildPrompt({
      employee_name,
      role,
      quarter,
      questions,
      achievements,
      values,
      current_notes,
      prior_forms_text,
    });

    const draft = await callAzureOpenAI([
      {
        role: "system",
        content:
          "You are a helpful assistant that returns only valid JSON and nothing else.",
      },
      { role: "user", content: prompt },
    ]);

    res.json(draft);
  } catch (error) {
    console.error("Draft generation error:", error);
    res.status(500).json({
      error: "Failed to generate draft.",
      detail: error.message,
    });
  }
});

function addWrappedText(doc, label, value, x, y, opts = {}) {
  const labelWidth = opts.labelWidth ?? 140;
  const contentWidth = opts.contentWidth ?? 400;
  const lineGap = opts.lineGap ?? 4;
  const fontSize = opts.fontSize ?? 10;

  doc.font("Helvetica-Bold").fontSize(fontSize).fillColor("#0f172a").text(label, x, y, {
    width: labelWidth,
    continued: true,
  });
  doc.font("Helvetica").fillColor("#1f2937").text(value || "-", x + labelWidth, y, {
    width: contentWidth,
    lineGap,
  });
}

function drawList(doc, title, items, x, y, options = {}) {
  const width = options.width ?? 515;
  const gap = options.gap ?? 6;
  const titleSize = options.titleSize ?? 12;
  const itemSize = options.itemSize ?? 10;
  const bulletIndent = options.bulletIndent ?? 12;

  doc.font("Helvetica-Bold").fontSize(titleSize).fillColor("#0f172a").text(title, x, y);
  let cursorY = y + 18;

  if (!items || !items.length) {
    doc.font("Helvetica-Oblique").fontSize(itemSize).fillColor("#64748b").text("None", x, cursorY, { width });
    return cursorY + 16;
  }

  items.forEach((item) => {
    const startY = cursorY;
    doc.font("Helvetica").fontSize(itemSize).fillColor("#1f2937").text(`• ${item}`, x + bulletIndent, startY, {
      width: width - bulletIndent,
      lineGap: 4,
    });
    cursorY = doc.y + gap;
  });

  return cursorY;
}

function buildPdfBuffer(draft) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 42 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.rect(0, 0, doc.page.width, 92).fill("#0f172a");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(22).text("Quarterly Check-in Form", 42, 28);
    doc.font("Helvetica").fontSize(10).fillColor("#cbd5e1").text("Generated from employee inputs and AI-assisted drafting", 42, 58);

    doc.fillColor("#0f172a");
    let y = 120;

    const title = draft?.title || "Check-in Draft";
    const summary = draft?.summary || "";

    doc.roundedRect(42, y, pageWidth, 74, 12).fillAndStroke("#f8fafc", "#cbd5e1");
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(14).text(title, 56, y + 14, { width: pageWidth - 28 });
    doc.font("Helvetica").fontSize(10).fillColor("#334155").text(summary || "No summary provided.", 56, y + 36, { width: pageWidth - 28, lineGap: 4 });

    y += 96;

    doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a").text("Section Answers", 42, y);
    y += 20;

    const answers = Array.isArray(draft?.section_answers) ? draft.section_answers : [];
    if (!answers.length) {
      doc.font("Helvetica-Oblique").fontSize(10).fillColor("#64748b").text("No section answers provided.", 42, y);
      y += 18;
    } else {
      for (const item of answers) {
        const startY = y;
        const boxHeight = 76;
        doc.roundedRect(42, startY, pageWidth, boxHeight, 10).fillAndStroke("#ffffff", "#e2e8f0");
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text("Question:", 54, startY + 12, { width: 70 });
        doc.font("Helvetica").fontSize(10).fillColor("#1f2937").text(item.question || "", 112, startY + 12, { width: pageWidth - 82 });
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text("Answer:", 54, startY + 28, { width: 70 });
        doc.font("Helvetica").fontSize(10).fillColor("#1f2937").text(item.answer || "", 112, startY + 28, { width: pageWidth - 82, lineGap: 4 });
        const evidence = Array.isArray(item.evidence_used) ? item.evidence_used.join(" | ") : "";
        const confirmation = Array.isArray(item.needs_confirmation) ? item.needs_confirmation.join(" | ") : "";
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#475569").text(`Evidence: ${evidence || "None"}`, 54, startY + 50, { width: pageWidth - 82 });
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#475569").text(`Needs confirmation: ${confirmation || "None"}`, 54, startY + 62, { width: pageWidth - 82 });
        y += boxHeight + 12;
        if (y > 720) {
          doc.addPage();
          y = 42;
        }
      }
    }

    if (y > 700) {
      doc.addPage();
      y = 42;
    }

    y = drawList(doc, "Achievements", draft?.achievements, 42, y, { width: pageWidth });
    y += 10;
    if (y > 700) {
      doc.addPage();
      y = 42;
    }

    doc.font("Helvetica-Bold").fontSize(12).fillColor("#0f172a").text("Values mapping", 42, y);
    y += 18;

    const mappings = Array.isArray(draft?.value_mappings) ? draft.value_mappings : [];
    if (!mappings.length) {
      doc.font("Helvetica-Oblique").fontSize(10).fillColor("#64748b").text("None", 42, y);
      y += 16;
    } else {
      for (const v of mappings) {
        const startY = y;
        const boxHeight = 68;
        doc.roundedRect(42, startY, pageWidth, boxHeight, 10).fillAndStroke("#f8fafc", "#e2e8f0");
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text(v.value_name || "Value", 54, startY + 12, { width: 150 });
        doc.font("Helvetica").fontSize(10).fillColor("#1f2937").text(v.evidence || "", 54, startY + 28, { width: pageWidth - 28, lineGap: 4 });
        doc.font("Helvetica").fontSize(9).fillColor("#475569").text(`Impact: ${v.impact || ""}   Confidence: ${v.confidence || ""}`, 54, startY + 48, { width: pageWidth - 28 });
        y += boxHeight + 10;
        if (y > 720) {
          doc.addPage();
          y = 42;
        }
      }
    }

    y = drawList(doc, "Risks / gaps", draft?.risks_or_gaps, 42, y, { width: pageWidth });
    y += 8;
    if (y > 700) {
      doc.addPage();
      y = 42;
    }
    y = drawList(doc, "Needs confirmation", draft?.needs_confirmation, 42, y, { width: pageWidth });
    y += 8;
    if (y > 700) {
      doc.addPage();
      y = 42;
    }
    y = drawList(doc, "Compliance notes", draft?.compliance_notes, 42, y, { width: pageWidth });
    y += 8;
    if (y > 700) {
      doc.addPage();
      y = 42;
    }
    y = drawList(doc, "Suggested next steps", draft?.suggested_next_steps, 42, y, { width: pageWidth });

    doc.end();
  });
}

app.post("/api/pdf", async (req, res) => {
  try {
    const draft = req.body || {};
    const pdf = await buildPdfBuffer(draft);

    const name = draft?.title ? draft.title.replace(/[^a-z0-9\-_]+/gi, "_").replace(/^_+|_+$/g, "") : "checkin-draft";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${name || "checkin-draft"}.pdf"`);
    res.send(pdf);
  } catch (error) {
    console.error("PDF generation error:", error);
    res.status(500).json({
      error: "Failed to generate PDF.",
      detail: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
