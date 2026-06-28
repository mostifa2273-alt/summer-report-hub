const APP_VERSION = "1.1.0-one-link";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function randomString(length = 16) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function cleanString(value, max = 1400) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanMultiLine(value, max = 4000) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\r\n/g, "\n").trim().slice(0, max);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeMeta(input = {}) {
  return {
    studentName: cleanString(input.studentName, 120),
    courseTitle: cleanString(input.courseTitle, 160),
    organization: cleanString(input.organization, 160),
    mentorName: cleanString(input.mentorName, 120),
    period: cleanString(input.period, 120),
  };
}

function statusOf(obj, requiredKeys) {
  const filled = requiredKeys.filter((key) => String(obj?.[key] ?? "").trim().length > 0).length;
  return {
    filled,
    total: requiredKeys.length,
    percent: Math.round((filled / requiredKeys.length) * 100),
  };
}

function sanitizeSection(role, body = {}) {
  if (role === "student") {
    return {
      summary: cleanMultiLine(body.summary, 1300),
      learned: cleanMultiLine(body.learned, 1400),
      practice: cleanMultiLine(body.practice, 1200),
      difficulty: cleanMultiLine(body.difficulty, 1000),
      nextPlan: cleanMultiLine(body.nextPlan, 1000),
      effort: cleanString(body.effort, 30),
      mood: cleanString(body.mood, 60),
    };
  }

  if (role === "teacher") {
    return {
      attendance: cleanString(body.attendance, 60),
      participation: cleanString(body.participation, 60),
      progress: cleanString(body.progress, 60),
      focus: cleanString(body.focus, 60),
      strengths: cleanMultiLine(body.strengths, 1200),
      needsPractice: cleanMultiLine(body.needsPractice, 1200),
      nextRecommendation: cleanMultiLine(body.nextRecommendation, 1200),
      score: cleanString(body.score, 40),
      finalComment: cleanMultiLine(body.finalComment, 1500),
      teacherSignature: cleanString(body.teacherSignature, 120),
    };
  }

  if (role === "parent") {
    return {
      readStatus: cleanString(body.readStatus, 60),
      comment: cleanMultiLine(body.comment, 1200),
      support: cleanMultiLine(body.support, 1000),
      question: cleanMultiLine(body.question, 900),
      signature: cleanString(body.signature, 120),
    };
  }

  return null;
}

function publicReport(report, origin) {
  const shareLink = `${origin}/?r=${encodeURIComponent(report.code + "-" + report.accessKey)}`;
  return {
    version: APP_VERSION,
    code: report.code,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    meta: report.meta,
    student: report.student,
    teacher: report.teacher,
    parent: report.parent,
    status: {
      student: statusOf(report.student, ["summary", "learned", "practice", "difficulty", "nextPlan", "effort"]),
      teacher: statusOf(report.teacher, ["attendance", "participation", "progress", "focus", "strengths", "needsPractice", "nextRecommendation", "score"]),
      parent: statusOf(report.parent, ["readStatus", "comment", "support", "signature"]),
    },
    shareLink,
  };
}

export class ReportObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/internal/init") {
      const existing = await this.state.storage.get("report");
      if (existing) return json({ error: "این کد قبلاً ساخته شده است." }, 409);
      const report = await request.json();
      await this.state.storage.put("report", report);
      return json({ ok: true });
    }

    const report = await this.state.storage.get("report");
    if (!report) return json({ error: "گزارش پیدا نشد." }, 404);

    const key = url.searchParams.get("key") || request.headers.get("x-report-key") || "";
    if (!key || key !== report.accessKey) {
      return json({ error: "لینک گزارش معتبر نیست یا ناقص است." }, 403);
    }

    if (request.method === "GET" && url.pathname === "/internal/report") {
      return json(publicReport(report, url.origin));
    }

    if (request.method === "PUT" && url.pathname === "/internal/report") {
      const body = await request.json().catch(() => ({}));
      const role = cleanString(body.role, 20);
      const update = sanitizeSection(role, body.data || {});
      if (!update) return json({ error: "نقش انتخاب‌شده معتبر نیست." }, 400);

      report[role] = { ...report[role], ...update, updatedAt: nowIso() };
      report.updatedAt = nowIso();
      report.history = [
        ...(report.history || []).slice(-40),
        { role, at: report.updatedAt, action: "update" },
      ];
      await this.state.storage.put("report", report);
      return json(publicReport(report, url.origin));
    }

    return json({ error: "مسیر پشتیبانی نمی‌شود." }, 404);
  }
}

async function createReport(request, env) {
  let data = {};
  try {
    data = await request.json();
  } catch (_) {
    return json({ error: "اطلاعات ارسالی معتبر نیست." }, 400);
  }

  const meta = normalizeMeta(data);
  if (!meta.studentName || !meta.courseTitle) {
    return json({ error: "نام دانش‌آموز و عنوان دوره ضروری است." }, 400);
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomString(6);
    const id = env.REPORTS.idFromName(code);
    const stub = env.REPORTS.get(id);
    const createdAt = nowIso();
    const report = {
      code,
      accessKey: randomString(24),
      createdAt,
      updatedAt: createdAt,
      meta,
      student: {
        summary: "",
        learned: "",
        practice: "",
        difficulty: "",
        nextPlan: "",
        effort: "",
        mood: "",
      },
      teacher: {
        attendance: "",
        participation: "",
        progress: "",
        focus: "",
        strengths: "",
        needsPractice: "",
        nextRecommendation: "",
        score: "",
        finalComment: "",
        teacherSignature: "",
      },
      parent: {
        readStatus: "",
        comment: "",
        support: "",
        question: "",
        signature: "",
      },
      history: [],
    };

    const initRes = await stub.fetch(new URL("/internal/init", request.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });

    if (initRes.status === 409) continue;
    if (!initRes.ok) return json({ error: "ساخت گزارش ناموفق بود." }, 500);

    return json(publicReport(report, new URL(request.url).origin), 201);
  }

  return json({ error: "ساخت کد یکتا ناموفق بود؛ دوباره تلاش کنید." }, 500);
}

async function routeReport(request, env, code) {
  const id = env.REPORTS.idFromName(code.toUpperCase());
  const stub = env.REPORTS.get(id);
  const url = new URL(request.url);
  const internalUrl = new URL("/internal/report", url.origin);
  internalUrl.search = url.search;
  return stub.fetch(new Request(internalUrl, request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/create" && request.method === "POST") {
      return createReport(request, env);
    }

    const reportMatch = url.pathname.match(/^\/api\/reports\/([A-Z0-9]{5,10})$/i);
    if (reportMatch && ["GET", "PUT"].includes(request.method)) {
      return routeReport(request, env, reportMatch[1]);
    }

    if (url.pathname === "/health") {
      return json({ ok: true, version: APP_VERSION });
    }

    return html(APP_HTML);
  },
};

const APP_HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0f172a" />
<title>گزارش‌یار تابستانی</title>
<style>
:root{
  --bg:#f7f8fb;--card:#ffffff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--soft:#f1f5f9;
  --brand:#0f766e;--brand2:#115e59;--amber:#92400e;--danger:#b91c1c;--ok:#15803d;
  --shadow:0 18px 50px rgba(15,23,42,.10);--r:22px;--r2:16px;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at top right,#ddfbf4,transparent 34%),radial-gradient(circle at 10% 20%,#e0f2fe,transparent 24%),var(--bg);font-family:Vazirmatn,IRANSans,Segoe UI,Tahoma,Arial,sans-serif;color:var(--ink);line-height:1.7}
button,input,textarea,select{font:inherit} button{cursor:pointer}
.wrap{width:min(1120px,calc(100% - 28px));margin:0 auto;padding:24px 0 48px}
.hero{display:grid;grid-template-columns:1.12fr .88fr;gap:18px;align-items:stretch}
.panel,.card{background:rgba(255,255,255,.9);backdrop-filter:blur(10px);border:1px solid rgba(226,232,240,.95);border-radius:var(--r);box-shadow:var(--shadow)}
.panel{padding:26px}.card{padding:18px}.brand{display:flex;gap:12px;align-items:center;margin-bottom:12px}
.logo{width:50px;height:50px;border-radius:18px;background:linear-gradient(135deg,var(--brand),#14b8a6);display:grid;place-items:center;color:white;font-weight:900;font-size:23px;box-shadow:0 12px 30px rgba(15,118,110,.28)}
h1{margin:0;font-size:clamp(29px,4vw,48px);letter-spacing:-.045em;line-height:1.2}.lead{color:var(--muted);font-size:17px;margin:14px 0 0}.muted{color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}.chip{padding:7px 11px;border:1px solid var(--line);background:var(--soft);border-radius:999px;color:#334155;font-size:13px}
.side{display:grid;gap:12px}.mini{padding:18px}.mini b{display:block;margin-bottom:5px}.mini p{margin:0;color:var(--muted);font-size:14px}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.btn{border:0;border-radius:15px;padding:12px 16px;background:var(--ink);color:white;font-weight:850;box-shadow:0 12px 26px rgba(15,23,42,.18)}.btn.secondary{background:#e6fffb;color:var(--brand2);box-shadow:none;border:1px solid #99f6e4}.btn.ghost{background:white;color:var(--ink);border:1px solid var(--line);box-shadow:none}.btn.warn{background:#fff7ed;color:#9a3412;border:1px solid #fed7aa;box-shadow:none}.btn.active{background:var(--brand);color:white;border:0}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:16px}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field{margin:12px 0}.label{display:flex;align-items:center;justify-content:space-between;font-weight:850;margin-bottom:6px;font-size:14px}.hint{font-size:12px;color:var(--muted);font-weight:500}
.input,.textarea,.select{width:100%;border:1px solid var(--line);border-radius:14px;background:#fff;color:var(--ink);padding:12px 13px;outline:none}.textarea{min-height:92px;resize:vertical}.input:focus,.textarea:focus,.select:focus{border-color:#2dd4bf;box-shadow:0 0 0 4px rgba(45,212,191,.18)}
.hidden{display:none!important}.toolbar{position:sticky;top:0;z-index:10;margin:0 0 16px;padding:12px;background:rgba(247,248,251,.78);backdrop-filter:blur(14px);border-bottom:1px solid rgba(226,232,240,.8)}.toolbarIn{width:min(1120px,calc(100% - 28px));margin:0 auto;display:flex;gap:10px;align-items:center;justify-content:space-between}
.role{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.pill{padding:8px 12px;border-radius:999px;background:#ecfeff;color:#155e75;border:1px solid #a5f3fc;font-weight:850;font-size:13px}.reportHead{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.codeBox{direction:ltr;background:#0f172a;color:white;border-radius:16px;padding:12px 14px;font-weight:900;letter-spacing:.14em;text-align:center}.progress{height:10px;background:#e2e8f0;border-radius:99px;overflow:hidden}.bar{height:100%;background:linear-gradient(90deg,var(--brand),#14b8a6);width:0%}.kpi{font-size:27px;font-weight:950;line-height:1}.summary{white-space:pre-wrap;background:#f8fafc;border:1px solid var(--line);border-radius:14px;padding:12px;min-height:54px;color:#334155}.empty{color:#94a3b8;font-style:italic}.linkLine{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}.linkLine input{direction:ltr;text-align:left}.roleTabs{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.roleTabs .btn{box-shadow:none}.toast{position:fixed;left:18px;bottom:18px;background:#0f172a;color:white;padding:12px 15px;border-radius:15px;box-shadow:var(--shadow);z-index:99;max-width:min(420px,calc(100% - 36px))}.footer{margin-top:20px;color:var(--muted);font-size:13px;text-align:center}.divider{height:1px;background:var(--line);margin:16px 0}.notice{border:1px solid #fde68a;background:#fffbeb;color:#78350f;border-radius:16px;padding:12px;margin-top:12px}.okText{color:var(--ok)}
@media(max-width:860px){.hero,.grid,.two{grid-template-columns:1fr}.reportHead{display:block}.toolbarIn{align-items:flex-start;flex-direction:column}.actions{width:100%}.btn{flex:1}.panel{padding:20px}.wrap{width:min(100% - 18px,1120px)}.linkLine{grid-template-columns:1fr}.roleTabs .btn{min-width:30%}}
@media print{body{background:white}.toolbar,.hero,.noPrint,.toast{display:none!important}.wrap{width:100%;padding:0}.card,.panel{box-shadow:none;border:1px solid #cbd5e1;break-inside:avoid}.grid{grid-template-columns:1fr 1fr 1fr}.textarea,.input,.select{border:0;background:white;padding:0}.btn{display:none}.summary{border:1px solid #cbd5e1;background:white}.wrap:before{content:"گزارش دوره / کارگاه تابستانی";display:block;font-size:24px;font-weight:900;margin:0 0 12px}}
</style>
</head>
<body>
<div id="toolbar" class="toolbar hidden">
  <div class="toolbarIn">
    <div class="role"><b>گزارش‌یار تابستانی</b><span id="activeRolePill" class="pill"></span><span id="saveState" class="muted"></span></div>
    <div class="actions" style="margin:0"><button class="btn ghost" onclick="window.print()">چاپ / ذخیره PDF</button><button class="btn ghost" onclick="copySharedLink()">کپی لینک مشترک</button><button class="btn warn" onclick="logout()">خروج</button></div>
  </div>
</div>
<main class="wrap">
  <section id="home" class="hero">
    <div class="panel">
      <div class="brand"><div class="logo">گ</div><div><b>گزارش‌یار تابستانی</b><div class="muted">یک لینک مشترک برای دانش‌آموز، مربی و والدین</div></div></div>
      <h1>یک گزارش آنلاین؛ همه با یک لینک</h1>
      <p class="lead">دانش‌آموز گزارش یادگیری را می‌نویسد، مربی ارزیابی اضافه می‌کند و والدین بازخورد می‌دهند. همه با همان لینک وارد می‌شوند و داخل صفحه نقش خود را انتخاب می‌کنند.</p>
      <div class="chips"><span class="chip">فقط یک لینک</span><span class="chip">بدون ساخت حساب</span><span class="chip">مناسب موبایل و تبلت</span><span class="chip">خروجی PDF با چاپ</span></div>
      <div class="actions"><button class="btn" onclick="showCreate()">ساخت گزارش جدید</button><button class="btn secondary" onclick="showJoin()">ورود با کد و کلید</button></div>
      <div class="notice"><b>روش استفاده:</b> بعد از ساخت گزارش، فقط همان لینک مشترک را برای دانش‌آموز، مربی و والدین بفرستید.</div>
    </div>
    <div class="side">
      <div class="mini card"><b>دانش‌آموز</b><p>کوتاه و روشن می‌نویسد: چه یاد گرفتم، چه تمرین کردم، چه چیزی سخت بود و قدم بعدی چیست.</p></div>
      <div class="mini card"><b>مربی / معلم</b><p>حضور، مشارکت، پیشرفت، تمرکز، نقاط قوت و پیشنهاد مرحله بعد را ثبت می‌کند.</p></div>
      <div class="mini card"><b>والدین</b><p>گزارش را می‌بینند، سؤال می‌پرسند و نوع حمایت خانه را مشخص می‌کنند.</p></div>
    </div>
  </section>

  <section id="createBox" class="card hidden" style="margin-top:16px">
    <h2>ساخت گزارش جدید</h2>
    <div class="two"><div class="field"><div class="label">نام دانش‌آموز</div><input id="c_studentName" class="input" placeholder="مثلاً: آرمان رضایی"></div><div class="field"><div class="label">عنوان دوره / کارگاه</div><input id="c_courseTitle" class="input" placeholder="مثلاً: رباتیک مقدماتی"></div></div>
    <div class="two"><div class="field"><div class="label">مؤسسه / برگزارکننده</div><input id="c_organization" class="input" placeholder="اختیاری"></div><div class="field"><div class="label">نام مربی / معلم</div><input id="c_mentorName" class="input" placeholder="اختیاری"></div></div>
    <div class="field"><div class="label">بازه زمانی گزارش</div><input id="c_period" class="input" placeholder="مثلاً: هفته اول تابستان / ۱ تا ۷ تیر"></div>
    <div class="actions"><button class="btn" onclick="createReport()">ساخت و دریافت لینک مشترک</button><button class="btn ghost" onclick="hideCreateJoin()">بستن</button></div>
  </section>

  <section id="joinBox" class="card hidden" style="margin-top:16px">
    <h2>ورود دستی</h2>
    <p class="muted">اگر لینک مشترک را ندارید، کد گزارش و کلید دسترسی را وارد کنید.</p>
    <div class="two"><div class="field"><div class="label">کد گزارش</div><input id="j_code" class="input" dir="ltr" placeholder="مثلاً: ABC234"></div><div class="field"><div class="label">کلید دسترسی</div><input id="j_key" class="input" dir="ltr" placeholder="بخش دوم لینک"></div></div>
    <div class="actions"><button class="btn" onclick="joinReport()">ورود</button><button class="btn ghost" onclick="hideCreateJoin()">بستن</button></div>
  </section>

  <section id="app" class="hidden">
    <section class="card">
      <div class="reportHead">
        <div><h2 id="rTitle">گزارش دوره</h2><div id="rMeta" class="muted"></div></div>
        <div><div class="muted" style="text-align:center">کد گزارش</div><div id="rCode" class="codeBox"></div></div>
      </div>
      <div class="divider"></div>
      <div class="linkLine noPrint"><input id="sharedLink" class="input" readonly><button class="btn secondary" onclick="copySharedLink()">کپی لینک مشترک</button></div>
      <div class="notice noPrint">همین یک لینک را برای همه بفرستید. هر نفر داخل همین صفحه نقش خود را انتخاب می‌کند.</div>
      <div class="roleTabs noPrint">
        <button id="tab_student" class="btn ghost" onclick="setRole('student')">من دانش‌آموزم</button>
        <button id="tab_teacher" class="btn ghost" onclick="setRole('teacher')">من مربی / معلم هستم</button>
        <button id="tab_parent" class="btn ghost" onclick="setRole('parent')">من والد هستم</button>
      </div>
    </section>

    <section class="grid">
      <div class="card"><b>گزارش دانش‌آموز</b><div class="kpi" id="stStudent">0%</div><div class="progress"><div id="barStudent" class="bar"></div></div></div>
      <div class="card"><b>ارزیابی مربی</b><div class="kpi" id="stTeacher">0%</div><div class="progress"><div id="barTeacher" class="bar"></div></div></div>
      <div class="card"><b>بازخورد والدین</b><div class="kpi" id="stParent">0%</div><div class="progress"><div id="barParent" class="bar"></div></div></div>
    </section>

    <section class="grid">
      <div class="card"><h3>خلاصه دانش‌آموز</h3><div id="viewStudent" class="summary empty"></div></div>
      <div class="card"><h3>ارزیابی مربی</h3><div id="viewTeacher" class="summary empty"></div></div>
      <div class="card"><h3>بازخورد والدین</h3><div id="viewParent" class="summary empty"></div></div>
    </section>

    <section id="studentEditor" class="card hidden" style="margin-top:16px">
      <h2>تکمیل توسط دانش‌آموز</h2>
      <div class="field"><div class="label">خلاصه خیلی کوتاه از کلاس / کارگاه</div><textarea id="s_summary" class="textarea" placeholder="امروز یا این هفته درباره چه چیزی یاد گرفتم؟"></textarea></div>
      <div class="field"><div class="label">سه چیز مهمی که یاد گرفتم</div><textarea id="s_learned" class="textarea" placeholder="۱) ...\n۲) ...\n۳) ..."></textarea></div>
      <div class="field"><div class="label">تمرین، پروژه یا فعالیتی که انجام دادم</div><textarea id="s_practice" class="textarea"></textarea></div>
      <div class="field"><div class="label">چه چیزی برایم سخت بود؟</div><textarea id="s_difficulty" class="textarea"></textarea></div>
      <div class="field"><div class="label">قدم بعدی من قبل از جلسه بعد</div><textarea id="s_nextPlan" class="textarea"></textarea></div>
      <div class="two"><div class="field"><div class="label">میزان تلاش من</div><select id="s_effort" class="select"><option value="">انتخاب کنید</option><option>۵ از ۵ - عالی</option><option>۴ از ۵ - خوب</option><option>۳ از ۵ - متوسط</option><option>۲ از ۵ - نیازمند بهتر شدن</option><option>۱ از ۵ - کم</option></select></div><div class="field"><div class="label">حس من نسبت به دوره</div><input id="s_mood" class="input" placeholder="مثلاً: علاقه‌مند، باانگیزه، کمی گیج"></div></div>
      <div class="actions"><button class="btn" onclick="saveRole('student')">ذخیره گزارش دانش‌آموز</button></div>
    </section>

    <section id="teacherEditor" class="card hidden" style="margin-top:16px">
      <h2>تکمیل توسط مربی / معلم</h2>
      <div class="two"><div class="field"><div class="label">حضور و نظم</div><select id="t_attendance" class="select"><option value="">انتخاب کنید</option><option>عالی</option><option>خوب</option><option>قابل قبول</option><option>نیازمند پیگیری</option></select></div><div class="field"><div class="label">مشارکت در کلاس</div><select id="t_participation" class="select"><option value="">انتخاب کنید</option><option>فعال و مؤثر</option><option>خوب</option><option>کم اما رو به بهبود</option><option>نیازمند تشویق</option></select></div></div>
      <div class="two"><div class="field"><div class="label">پیشرفت مهارتی</div><select id="t_progress" class="select"><option value="">انتخاب کنید</option><option>پیشرفت چشمگیر</option><option>پیشرفت خوب</option><option>پیشرفت تدریجی</option><option>نیازمند تمرین بیشتر</option></select></div><div class="field"><div class="label">تمرکز و پیگیری</div><select id="t_focus" class="select"><option value="">انتخاب کنید</option><option>بسیار متمرکز</option><option>متمرکز در بیشتر زمان‌ها</option><option>گاهی حواس‌پرت</option><option>نیازمند ساختار و یادآوری</option></select></div></div>
      <div class="field"><div class="label">نقاط قوت دانش‌آموز</div><textarea id="t_strengths" class="textarea"></textarea></div>
      <div class="field"><div class="label">مواردی که باید بیشتر تمرین شود</div><textarea id="t_needsPractice" class="textarea"></textarea></div>
      <div class="field"><div class="label">پیشنهاد مربی برای مرحله بعد</div><textarea id="t_nextRecommendation" class="textarea"></textarea></div>
      <div class="two"><div class="field"><div class="label">امتیاز کلی</div><input id="t_score" class="input" placeholder="مثلاً: ۸۵ از ۱۰۰"></div><div class="field"><div class="label">نام / امضای مربی</div><input id="t_teacherSignature" class="input"></div></div>
      <div class="field"><div class="label">نظر نهایی مربی برای والدین</div><textarea id="t_finalComment" class="textarea"></textarea></div>
      <div class="actions"><button class="btn" onclick="saveRole('teacher')">ذخیره ارزیابی مربی</button></div>
    </section>

    <section id="parentEditor" class="card hidden" style="margin-top:16px">
      <h2>تکمیل توسط والدین</h2>
      <div class="field"><div class="label">وضعیت مشاهده گزارش</div><select id="p_readStatus" class="select"><option value="">انتخاب کنید</option><option>گزارش را خواندم</option><option>گزارش را خواندم و نیاز به گفت‌وگو داریم</option><option>منتظر تکمیل ارزیابی مربی هستم</option></select></div>
      <div class="field"><div class="label">بازخورد والدین</div><textarea id="p_comment" class="textarea"></textarea></div>
      <div class="field"><div class="label">حمایتی که در خانه انجام می‌دهیم</div><textarea id="p_support" class="textarea" placeholder="مثلاً: زمان مطالعه، وسیله لازم، تمرین مشترک، یادآوری آرام"></textarea></div>
      <div class="field"><div class="label">سؤال از دانش‌آموز یا مربی</div><textarea id="p_question" class="textarea"></textarea></div>
      <div class="field"><div class="label">نام / امضای والد</div><input id="p_signature" class="input"></div>
      <div class="actions"><button class="btn" onclick="saveRole('parent')">ذخیره بازخورد والدین</button></div>
    </section>

    <div class="footer">طراحی‌شده برای گزارش کوتاه، محترمانه و قابل پیگیری دوره‌ها و کارگاه‌های تابستانی.</div>
  </section>
</main>
<div id="toast" class="toast hidden"></div>
<script>
const $ = function(id){ return document.getElementById(id); };
let state = { code:null, key:null, data:null, role:localStorage.getItem("summerReportRole") || "student" };
const roleName = { student:"دانش‌آموز", teacher:"مربی / معلم", parent:"والدین" };

function showToast(msg){ const t=$("toast"); t.textContent=msg; t.classList.remove("hidden"); setTimeout(function(){ t.classList.add("hidden"); },3200); }
function showCreate(){ $("createBox").classList.remove("hidden"); $("joinBox").classList.add("hidden"); }
function showJoin(){ $("joinBox").classList.remove("hidden"); $("createBox").classList.add("hidden"); }
function hideCreateJoin(){ $("createBox").classList.add("hidden"); $("joinBox").classList.add("hidden"); }
function setBusy(txt){ $("saveState").textContent = txt || ""; }
async function api(path, options){
  const res = await fetch(path, Object.assign({}, options || {}, { headers:Object.assign({"content-type":"application/json"}, (options && options.headers) || {}) }));
  const data = await res.json().catch(function(){ return {error:"پاسخ سرور قابل خواندن نیست."}; });
  if(!res.ok) throw new Error(data.error || "خطا رخ داد.");
  return data;
}
function makeShareUrl(code,key){ return location.origin + "/?r=" + encodeURIComponent(code + "-" + key); }
function parseSharedValue(value){
  const raw = String(value || "").trim();
  if(!raw) return null;
  let r = raw;
  try { const u = new URL(raw); r = u.searchParams.get("r") || raw; } catch(e) {}
  r = decodeURIComponent(r).trim();
  const parts = r.split("-");
  if(parts.length < 2) return null;
  return { code:parts[0].toUpperCase(), key:parts.slice(1).join("-") };
}
function saveSession(code,key){ localStorage.setItem("summerReportOneLink", JSON.stringify({code:code,key:key})); }
function readSession(){ try{return JSON.parse(localStorage.getItem("summerReportOneLink")||"null");}catch(e){return null;} }
function logout(){ localStorage.removeItem("summerReportOneLink"); location.href="/"; }
function copyText(text){ navigator.clipboard.writeText(text).then(function(){ showToast("لینک مشترک کپی شد."); },function(){ showToast("کپی نشد؛ دستی کپی کنید."); }); }
function copySharedLink(){ if(!state.code || !state.key) return; copyText(makeShareUrl(state.code,state.key)); }

async function createReport(){
  const payload = {
    studentName: $("c_studentName").value,
    courseTitle: $("c_courseTitle").value,
    organization: $("c_organization").value,
    mentorName: $("c_mentorName").value,
    period: $("c_period").value
  };
  try{
    setBusy("در حال ساخت...");
    const data = await api("/api/create", { method:"POST", body:JSON.stringify(payload) });
    const parsed = parseSharedValue(data.shareLink);
    saveSession(data.code, parsed.key);
    history.replaceState(null,"","/?r=" + encodeURIComponent(data.code + "-" + parsed.key));
    state.code = data.code; state.key = parsed.key; state.data = data;
    render(data);
    showToast("گزارش ساخته شد. فقط همین لینک مشترک را برای همه بفرستید.");
  }catch(e){ showToast(e.message); }
  finally{ setBusy(""); }
}

function joinReport(){
  const code = $("j_code").value.trim().toUpperCase();
  const key = $("j_key").value.trim();
  if(!code || !key) return showToast("کد گزارش و کلید دسترسی را وارد کنید.");
  saveSession(code,key); history.replaceState(null,"","/?r=" + encodeURIComponent(code + "-" + key)); loadReport(code,key);
}

async function loadReport(code,key){
  try{
    setBusy("در حال دریافت...");
    const data = await api("/api/reports/" + encodeURIComponent(code) + "?key=" + encodeURIComponent(key));
    state.code = code; state.key = key; state.data = data; render(data);
  }catch(e){ showToast(e.message); localStorage.removeItem("summerReportOneLink"); }
  finally{ setBusy(""); }
}

function valueOrDash(v){ return v && String(v).trim() ? String(v).trim() : "—"; }
function fill(id, value){ if($(id)) $(id).value = value || ""; }
function setPct(textId, barId, percent){ $(textId).textContent = percent + "%"; $(barId).style.width = percent + "%"; }
function linesBlock(lines){ const clean = lines.filter(function(x){ return x && String(x).trim(); }); return clean.length ? clean.join("\n\n") : "هنوز تکمیل نشده است."; }
function setSummary(id, text){ const el=$(id); el.textContent=text; el.classList.toggle("empty", text === "هنوز تکمیل نشده است."); }

function setRole(role){
  state.role = role; localStorage.setItem("summerReportRole", role);
  ["student","teacher","parent"].forEach(function(r){
    $("tab_"+r).className = r === role ? "btn active" : "btn ghost";
    $(r+"Editor").classList.toggle("hidden", r !== role);
  });
  $("activeRolePill").textContent = "نقش انتخابی: " + roleName[role];
}

function render(data){
  $("home").classList.add("hidden"); $("createBox").classList.add("hidden"); $("joinBox").classList.add("hidden");
  $("app").classList.remove("hidden"); $("toolbar").classList.remove("hidden");
  $("rTitle").textContent = data.meta.courseTitle || "گزارش دوره";
  $("rMeta").textContent = ["دانش‌آموز: "+valueOrDash(data.meta.studentName), data.meta.organization ? "برگزارکننده: "+data.meta.organization : "", data.meta.mentorName ? "مربی: "+data.meta.mentorName : "", data.meta.period ? "بازه: "+data.meta.period : ""].filter(Boolean).join(" | ");
  $("rCode").textContent = data.code;
  $("sharedLink").value = makeShareUrl(state.code, state.key);
  setPct("stStudent","barStudent",data.status.student.percent);
  setPct("stTeacher","barTeacher",data.status.teacher.percent);
  setPct("stParent","barParent",data.status.parent.percent);

  setSummary("viewStudent", linesBlock([
    data.student.summary && "خلاصه: " + data.student.summary,
    data.student.learned && "یادگیری‌ها: " + data.student.learned,
    data.student.practice && "تمرین‌ها: " + data.student.practice,
    data.student.difficulty && "چالش: " + data.student.difficulty,
    data.student.nextPlan && "قدم بعدی: " + data.student.nextPlan,
    data.student.effort && "تلاش: " + data.student.effort
  ]));
  setSummary("viewTeacher", linesBlock([
    data.teacher.attendance && "حضور و نظم: " + data.teacher.attendance,
    data.teacher.participation && "مشارکت: " + data.teacher.participation,
    data.teacher.progress && "پیشرفت: " + data.teacher.progress,
    data.teacher.focus && "تمرکز: " + data.teacher.focus,
    data.teacher.strengths && "نقاط قوت: " + data.teacher.strengths,
    data.teacher.needsPractice && "نیاز به تمرین: " + data.teacher.needsPractice,
    data.teacher.nextRecommendation && "پیشنهاد بعدی: " + data.teacher.nextRecommendation,
    data.teacher.score && "امتیاز: " + data.teacher.score,
    data.teacher.finalComment && "نظر نهایی: " + data.teacher.finalComment
  ]));
  setSummary("viewParent", linesBlock([
    data.parent.readStatus && "وضعیت: " + data.parent.readStatus,
    data.parent.comment && "بازخورد: " + data.parent.comment,
    data.parent.support && "حمایت: " + data.parent.support,
    data.parent.question && "سؤال: " + data.parent.question,
    data.parent.signature && "امضا: " + data.parent.signature
  ]));

  fill("s_summary", data.student.summary); fill("s_learned", data.student.learned); fill("s_practice", data.student.practice); fill("s_difficulty", data.student.difficulty); fill("s_nextPlan", data.student.nextPlan); fill("s_effort", data.student.effort); fill("s_mood", data.student.mood);
  fill("t_attendance", data.teacher.attendance); fill("t_participation", data.teacher.participation); fill("t_progress", data.teacher.progress); fill("t_focus", data.teacher.focus); fill("t_strengths", data.teacher.strengths); fill("t_needsPractice", data.teacher.needsPractice); fill("t_nextRecommendation", data.teacher.nextRecommendation); fill("t_score", data.teacher.score); fill("t_finalComment", data.teacher.finalComment); fill("t_teacherSignature", data.teacher.teacherSignature);
  fill("p_readStatus", data.parent.readStatus); fill("p_comment", data.parent.comment); fill("p_support", data.parent.support); fill("p_question", data.parent.question); fill("p_signature", data.parent.signature);
  setRole(state.role || "student");
}

async function saveRole(role){
  const dataByRole = {
    student:{ summary:$("s_summary").value, learned:$("s_learned").value, practice:$("s_practice").value, difficulty:$("s_difficulty").value, nextPlan:$("s_nextPlan").value, effort:$("s_effort").value, mood:$("s_mood").value },
    teacher:{ attendance:$("t_attendance").value, participation:$("t_participation").value, progress:$("t_progress").value, focus:$("t_focus").value, strengths:$("t_strengths").value, needsPractice:$("t_needsPractice").value, nextRecommendation:$("t_nextRecommendation").value, score:$("t_score").value, finalComment:$("t_finalComment").value, teacherSignature:$("t_teacherSignature").value },
    parent:{ readStatus:$("p_readStatus").value, comment:$("p_comment").value, support:$("p_support").value, question:$("p_question").value, signature:$("p_signature").value }
  };
  try{
    setBusy("در حال ذخیره...");
    const updated = await api("/api/reports/" + encodeURIComponent(state.code) + "?key=" + encodeURIComponent(state.key), { method:"PUT", body:JSON.stringify({role:role, data:dataByRole[role]}) });
    state.data = updated; render(updated); showToast("ذخیره شد.");
  }catch(e){ showToast(e.message); }
  finally{ setBusy(""); }
}

(function boot(){
  const params = new URLSearchParams(location.search);
  const fromUrl = parseSharedValue(params.get("r") || "");
  if(fromUrl){ saveSession(fromUrl.code, fromUrl.key); loadReport(fromUrl.code, fromUrl.key); return; }
  const s = readSession();
  if(s && s.code && s.key) loadReport(s.code, s.key);
})();
</script>
</body>
</html>`;
