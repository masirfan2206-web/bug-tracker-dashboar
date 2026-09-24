const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Octokit } = require('@octokit/rest');

const app = express();
app.use(cors());
app.use(express.json());

// Konfigurasi Kunci Akses (Nanti diisi di environment variables)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER; // Username GitHub kamu

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Penyimpanan Bug Sementara (In-Memory)
let bugLogs = [];

// 1. Endpoint Menerima Bug dari Client SDK
app.post('/api/report-bug', async (req, res) => {
  const { app_id, error_message, file, line, column, stack_trace, timestamp } = req.body;
  
  const bugItem = {
    id: Date.now(),
    app_id,
    error_message,
    file,
    line,
    column,
    stack_trace,
    timestamp,
    status: 'PENDING_ANALYSIS',
    ai_suggestion: null,
    fixed_code: null
  };

  bugLogs.unshift(bugItem);
  console.log(`[BUG DETECTED] ${error_message} at line ${line}`);

  // Langsung proses dengan Gemini AI di background
  analyzeBugWithAI(bugItem);

  res.status(200).json({ status: 'success', message: 'Bug reported successfully', bug_id: bugItem.id });
});

// 2. Fungsi Analisis Bug menggunakan Gemini AI
async function analyzeBugWithAI(bug) {
  try {
    // Ambil isi kode asli dari GitHub (web-uji-coba/index.html)
    const { data: fileData } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: 'Web-Uji-Coba',
      path: 'index.html',
    });

    const originalCode = Buffer.from(fileData.content, 'base64').toString('utf-8');

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `
    Kamu adalah Senior Software Engineer. Terjadi bug pada aplikasi web berikut:
    - Error Message: ${bug.error_message}
    - File: ${bug.file}
    - Line: ${bug.line}:${bug.column}
    - Stack Trace: ${bug.stack_trace}

    Berikut adalah kode sumber asli (index.html):
    \`\`\`html
    ${originalCode}
    \`\`\`

    Tugasmu:
    1. Jelaskan secara singkat penyebab bug ini dalam bahasa Indonesia.
    2. Berikan SELURUH kode HTML/JS baru yang sudah diperbaiki tanpa mengurangi fitur lain.

    Berikan output dalam format JSON valid tanpa format markdown tambahan:
    {
      "explanation": "Penjelasan bug dalam bahasa Indonesia",
      "fixed_code": "Seluruh isi kode index.html yang sudah diperbaiki"
    }
    `;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text().replace(/```json|```/g, '').trim();
    const aiResult = JSON.parse(responseText);

    bug.status = 'READY_FOR_REVIEW';
    bug.ai_suggestion = aiResult.explanation;
    bug.fixed_code = aiResult.fixed_code;
    bug.sha = fileData.sha; // Simpan SHA file untuk update ke GitHub nanti

    console.log(`[AI SUCCESS] Analysis completed for Bug #${bug.id}`);
  } catch (error) {
    console.error('[AI ERROR]', error);
    bug.status = 'ANALYSIS_FAILED';
  }
}

// 3. Endpoint Membaca Daftar Bug
app.get('/api/bugs', (req, res) => {
  res.json(bugLogs);
});

// 4. Endpoint Eksekusi Perbaikan ke GitHub (Manual Approval)
app.post('/api/apply-fix', async (req, res) => {
  const { bug_id } = req.body;
  const bug = bugLogs.find(b => b.id === bug_id);

  if (!bug || !bug.fixed_code) {
    return res.status(400).json({ error: 'Bug data or fix code not found' });
  }

  try {
    // Commit kode baru ke GitHub
    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER,
      repo: 'Web-Uji-Coba',
      path: 'index.html',
      message: `fix(autofix): auto-patched bug ${bug.error_message} via Bug Tracker Dashboard`,
      content: Buffer.from(bug.fixed_code).toString('base64'),
      sha: bug.sha,
    });

    bug.status = 'FIXED';
    res.json({ status: 'success', message: 'Kode berhasil diperbaiki dan di-commit ke GitHub!' });
  } catch (err) {
    console.error('[GITHUB COMMIT ERROR]', err);
    res.status(500).json({ error: 'Gagal melakukan commit ke GitHub' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard Server running on port ${PORT}`));
