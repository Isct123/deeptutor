import { useState, useEffect, useRef, useCallback } from "react";

const API_KEY = "AQ.Ab8RN6LyLlTK0h0gq34KCrEqMV8fD0auVKcw7Elk0wK2mD9JTA";
const GEMINI_MODEL = "gemini-2.5-flash";
const API = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${API_KEY}`;
const PAL = ["#7c6dfa", "#34d399", "#fb923c", "#f472b6", "#38bdf8", "#a3e635"];

const T = {
  bg: "#08080d",
  panel: "#0c0c16",
  card: "#101019",
  border: "#181828",
  bm: "#222236",
  accent: "#7c6dfa",
  acL: "#a89dfc",
  acS: "rgba(124,109,250,0.10)",
  green: "#34d399",
  gnS: "rgba(52,211,153,0.10)",
  amber: "#fbbf24",
  amS: "rgba(251,191,36,0.10)",
  text: "#eae8f8",
  sub: "#706e9e",
  dim: "#2e2c46",
};
const AI_RETRY_MESSAGE =
  "Gemini is busy or rate-limiting requests right now. Give it a moment, then send your last message again.";
const STORAGE_KEY = "deeptutor-state-v1";

const makeId = (prefix) =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const getInitials = (name) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");

const emptySession = () => ({
  messages: [],
  conceptProgress: {},
  completedArticles: [],
  currentArticleIndex: 0,
});

// ── Seed articles ──────────────────────────────────────────
const SEED = [];

// ── API helpers ────────────────────────────────────────────
function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

function readGeminiText(data) {
  return (data.candidates || [])
    .flatMap((c) => c.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n")
    .trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryableStatus = (status) =>
  [429, 500, 502, 503, 504].includes(status);

async function callAI(messages, system, extras = {}) {
  const { maxOutputTokens = 900, retries = 3, ...geminiExtras } = extras;
  const body = JSON.stringify({
    systemInstruction: {
      parts: [{ text: system }],
    },
    contents: toGeminiContents(messages),
    generationConfig: {
      maxOutputTokens,
    },
    ...geminiExtras,
  });

  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      const text = readGeminiText(data);
      if (text) return text;
      throw new Error("Gemini returned an empty response.");
    }

    if (!isRetryableStatus(r.status) || attempt === retries) {
      const msg =
        data.error?.message || r.statusText || "Gemini request failed";
      throw new Error(`${r.status}: ${msg}`);
    }

    const retryAfter = Number(r.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter)
      ? retryAfter * 1000
      : 900 * 2 ** attempt + Math.random() * 300;
    await sleep(delay);
  }

  throw new Error("Gemini request failed.");
}

async function fetchArticleFromURL(url) {
  const text = await callAI(
    [
      {
        role: "user",
        content: `Fetch the complete article text from this URL and return it in full: ${url}`,
      },
    ],
    "You are a content extractor. Use Google Search when needed to fetch the article at the given URL and return its COMPLETE body text in clean readable format with markdown. Include all substantive content. Do not include navigation, ads, or page chrome.",
    {
      maxOutputTokens: 4000,
      tools: [{ googleSearch: {} }],
    },
  );
  if (!text) throw new Error("No content extracted");
  return text;
}

async function suggestConceptsFromContent(content) {
  const r = await callAI(
    [
      {
        role: "user",
        content: `From this article, extract 4–6 key teachable concepts. Return ONLY a comma-separated list, nothing else:\n\n${content.slice(0, 2000)}`,
      },
    ],
    "You extract the core teachable concepts from educational content. Return a plain comma-separated list only.",
  );
  return r.trim().replace(/\.$/, "");
}

// ── EVAL parsing ───────────────────────────────────────────
function parseEval(text) {
  try {
    const m = text.match(/EVAL:\s*(\{[^{}]*\})/);
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

function cleanMsg(text) {
  return text
    .replace(/\n?EVAL:\s*\{[^{}]*\}/, "")
    .replace(/\s*DONE\|score=\d+/, "")
    .trim();
}

// ── Concept chip with live progress fill ───────────────────
function ConceptChip({ label, color, score = 0 }) {
  const done = score >= 0.85;
  const started = score > 0.05;
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 20,
        padding: "3px 11px",
        border: `1px solid ${started ? color + "55" : T.border}`,
        fontSize: 11,
        fontWeight: 500,
        color: started ? color : T.dim,
        transition: "color 0.4s, border-color 0.4s",
      }}
    >
      {/* fill bar */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: `${Math.round(score * 100)}%`,
          background: color + "1c",
          transition: "width 0.8s cubic-bezier(0.4,0,0.2,1)",
          borderRadius: "20px 0 0 20px",
          pointerEvents: "none",
        }}
      />
      <span style={{ position: "relative", zIndex: 1, lineHeight: 1.6 }}>
        {done ? "✓ " : ""}
        {label}
      </span>
    </div>
  );
}

// ── Canvas concept map ─────────────────────────────────────
function ConceptMap({ articles }) {
  const ref = useRef();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = 660,
      H = 350;
    ctx.clearRect(0, 0, W, H);

    if (!articles.length) {
      ctx.fillStyle = T.sub;
      ctx.font = "13px Inter,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Add articles to generate the concept map", W / 2, H / 2);
      return;
    }

    const aR = 32,
      aY = 68,
      mL = 90;
    const artN = articles.map((a, i) => ({
      ...a,
      r: aR,
      y: aY,
      color: PAL[i % PAL.length],
      x:
        articles.length === 1
          ? W / 2
          : mL + ((W - 2 * mL) / (articles.length - 1)) * i,
    }));

    // build concept positions
    const cmap = {};
    articles.forEach((a, ai) => {
      const an = artN[ai],
        n = a.concepts.length;
      a.concepts.forEach((c, ci) => {
        const frac = n === 1 ? 0.5 : ci / (n - 1);
        const angle = Math.PI * (0.12 + frac * 0.76);
        const rad = 105 + (ci % 2) * 28;
        const x = an.x + Math.cos(angle) * rad;
        const y = an.y + Math.sin(angle) * rad + 10;
        if (!cmap[c]) {
          cmap[c] = { label: c, x, y, r: 24, color: an.color, cnt: 1 };
        } else {
          const o = cmap[c];
          o.x = (o.x * o.cnt + x) / (o.cnt + 1);
          o.y = (o.y * o.cnt + y) / (o.cnt + 1);
          o.cnt++;
        }
      });
    });

    const cns = Object.values(cmap).map((n) => ({
      ...n,
      x: Math.max(n.r + 6, Math.min(W - n.r - 6, n.x)),
      y: Math.max(aY + aR + 30, Math.min(H - n.r - 12, n.y)),
    }));

    // edges
    articles.forEach((a, ai) => {
      const an = artN[ai];
      a.concepts.forEach((c) => {
        const cn = cmap[c];
        if (!cn) return;
        ctx.beginPath();
        ctx.moveTo(an.x, an.y + aR);
        ctx.quadraticCurveTo(
          (an.x + cn.x) / 2,
          an.y + aR + 26,
          cn.x,
          cn.y - cn.r,
        );
        ctx.strokeStyle = PAL[ai % PAL.length] + "30";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    });

    // concept nodes
    cns.forEach((n) => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.color + "12";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.strokeStyle = n.color + "62";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = T.text;
      ctx.font = "9px Inter,sans-serif";
      ctx.textAlign = "center";
      n.label
        .split(" ")
        .forEach((w, wi, arr) =>
          ctx.fillText(w, n.x, n.y + (wi - (arr.length - 1) / 2) * 11.5 + 0.5),
        );
    });

    // article nodes on top
    artN.forEach((n) => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 7, 0, Math.PI * 2);
      ctx.fillStyle = n.color + "08";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.color + "1e";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.strokeStyle = n.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = n.color;
      ctx.font = "bold 9.5px Inter,sans-serif";
      ctx.textAlign = "center";
      const ws = n.title.split(" ").slice(0, 3);
      ws.forEach((w, wi) =>
        ctx.fillText(w, n.x, n.y + (wi - (ws.length - 1) / 2) * 12 + 0.5),
      );
    });

    // legend
    ctx.font = "10px Inter,sans-serif";
    ctx.textAlign = "left";
    artN.forEach((n, i) => {
      const ly = H - 12 - (artN.length - 1 - i) * 18;
      ctx.beginPath();
      ctx.arc(12, ly - 4, 4, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.fillStyle = T.sub;
      ctx.fillText(n.title, 24, ly);
    });
  }, [articles]);

  return (
    <canvas
      ref={ref}
      width={660}
      height={350}
      style={{ display: "block", width: "100%" }}
    />
  );
}

// ── Chat bubble ────────────────────────────────────────────
function Bubble({ msg, accentColor }) {
  const isAI = msg.role === "assistant";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isAI ? "flex-start" : "flex-end",
        gap: 10,
        alignItems: "flex-start",
      }}
    >
      {isAI && (
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: T.acS,
            border: `1px solid ${T.accent}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            fontWeight: 600,
            color: T.acL,
            flexShrink: 0,
          }}
        >
          AI
        </div>
      )}
      <div
        style={{
          maxWidth: "74%",
          padding: "11px 15px",
          lineHeight: 1.65,
          fontSize: 14,
          borderRadius: isAI ? "3px 14px 14px 14px" : "14px 3px 14px 14px",
          background: isAI ? T.card : accentColor || T.accent,
          color: T.text,
          border: isAI ? `1px solid ${T.border}` : "none",
          whiteSpace: "pre-wrap",
        }}
      >
        {msg.content}
      </div>
    </div>
  );
}

const TypingDots = () => (
  <div
    style={{
      display: "flex",
      gap: 5,
      alignItems: "center",
      paddingLeft: 38,
      height: 28,
    }}
  >
    {[0, 1, 2].map((i) => (
      <div
        key={i}
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: T.sub,
          animation: `dot 1.2s ${i * 0.2}s infinite`,
        }}
      />
    ))}
  </div>
);

// ── Login ──────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
function Login({ accounts, onLogin, onCreateAccount }) {
  const [name, setName] = useState("");
  // eslint-disable-next-line no-unused-vars
  const [role, setRole] = useState("student");
  const canCreate = name.trim().length >= 2;

  // eslint-disable-next-line no-unused-vars
  const create = () => {
    if (!canCreate) return;
    onCreateAccount({ name: name.trim(), role });
    setName("");
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        fontFamily: "Inter,system-ui,sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 48,
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 16,
            background: T.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 24,
            margin: "0 auto 22px",
            color: "#fff",
            fontWeight: 700,
            boxShadow: `0 0 40px ${T.accent}45`,
          }}
        >
          ✦
        </div>
        <div
          style={{
            fontSize: 10,
            letterSpacing: 4,
            color: T.sub,
            textTransform: "uppercase",
            marginBottom: 12,
          }}
        >
          Learning Studio
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 42,
            fontWeight: 700,
            color: T.text,
            letterSpacing: "-1.5px",
          }}
        >
          Sign in
        </h1>
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        {[
          {
            role: "professor",
            icon: "🎓",
            title: "Professor",
            desc: "Upload content · set goals · monitor sessions",
          },
          {
            role: "student",
            icon: "📖",
            title: "Student",
            desc: "Read articles · learn · track understanding",
          },
        ].map(({ role, icon, title, desc }) => (
          <button
            key={role}
            onClick={() => onLogin(role)}
            style={{
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 18,
              padding: "36px 44px",
              cursor: "pointer",
              color: T.text,
              textAlign: "center",
              transition: "all 0.2s",
              width: 220,
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = T.accent;
              e.currentTarget.style.background = T.acS;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = T.border;
              e.currentTarget.style.background = T.card;
            }}
          >
            <div style={{ fontSize: 42, marginBottom: 16 }}>{icon}</div>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>
              {title}
            </div>
            <div style={{ fontSize: 13, color: T.sub, lineHeight: 1.7 }}>
              {desc}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Professor view ─────────────────────────────────────────
function AccountLogin({ accounts, onLogin, onCreateAccount }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("student");
  const canCreate = name.trim().length >= 2;

  const create = () => {
    if (!canCreate) return;
    onCreateAccount({ name: name.trim(), role });
    setName("");
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        fontFamily: "Inter,system-ui,sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 40,
        padding: 20,
        boxSizing: "border-box",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 16,
            background: T.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
            margin: "0 auto 22px",
            color: "#fff",
            fontWeight: 700,
            boxShadow: `0 0 40px ${T.accent}45`,
          }}
        >
          DT
        </div>
        <div
          style={{
            fontSize: 10,
            letterSpacing: 4,
            color: T.sub,
            textTransform: "uppercase",
            marginBottom: 12,
          }}
        >
          Learning Studio
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 42,
            fontWeight: 700,
            color: T.text,
            letterSpacing: "-1.5px",
          }}
        >
          Sign in
        </h1>
      </div>
      <div
        style={{
          width: "min(720px, 100%)",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 12,
            padding: 20,
          }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              marginBottom: 14,
              color: T.text,
            }}
          >
            Create account
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="Full name"
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: T.panel,
              border: `1px solid ${T.border}`,
              borderRadius: 8,
              padding: "10px 12px",
              color: T.text,
              fontSize: 14,
              outline: "none",
              fontFamily: "inherit",
              marginBottom: 10,
            }}
          />
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            {["student", "professor"].map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                style={{
                  flex: 1,
                  background: role === r ? T.acS : T.panel,
                  border: `1px solid ${role === r ? T.accent : T.border}`,
                  borderRadius: 8,
                  padding: "9px 10px",
                  color: role === r ? T.acL : T.sub,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  textTransform: "capitalize",
                }}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            onClick={create}
            disabled={!canCreate}
            style={{
              width: "100%",
              background: T.accent,
              border: "none",
              borderRadius: 8,
              padding: "10px 12px",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              opacity: canCreate ? 1 : 0.45,
              cursor: canCreate ? "pointer" : "default",
              fontFamily: "inherit",
            }}
          >
            Create and enter
          </button>
        </div>
        <div
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 12,
            padding: 20,
            minHeight: 204,
          }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              marginBottom: 14,
              color: T.text,
            }}
          >
            Existing accounts
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {accounts.length ? (
              accounts.map((account) => (
                <button
                  key={account.id}
                  onClick={() => onLogin(account.id)}
                  style={{
                    background: T.panel,
                    border: `1px solid ${T.border}`,
                    borderRadius: 9,
                    padding: "10px 12px",
                    color: T.text,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <span>{account.name}</span>
                  <span style={{ color: T.sub, textTransform: "capitalize" }}>
                    {account.role}
                  </span>
                </button>
              ))
            ) : (
              <div
                style={{
                  color: T.dim,
                  fontSize: 13,
                  lineHeight: 1.7,
                  padding: "18px 0",
                }}
              >
                No accounts yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Professor({ articles, setArticles, sessions, students, onAddStudent }) {
  const [tab, setTab] = useState("articles");
  const [form, setForm] = useState({
    title: "",
    goal: "",
    concepts: "",
    content: "",
    url: "",
  });
  const [flashId, setFlashId] = useState(null);
  const [picked, setPicked] = useState(null);
  const [studentName, setStudentName] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState(null); // { type:"ok"|"err", text }
  const chatEndRef = useRef();

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sessions, picked]);

  const F = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const addStudent = () => {
    if (!studentName.trim()) return;
    const student = onAddStudent(studentName.trim());
    setPicked(student.id);
    setStudentName("");
  };

  const handleFetch = async () => {
    if (!form.url.trim()) return;
    setFetching(true);
    setFetchMsg(null);
    try {
      const content = await fetchArticleFromURL(form.url.trim());
      F("content", content);
      setFetchMsg({ type: "ok", text: "Article fetched successfully." });
      // auto-suggest concepts if field is empty
      if (!form.concepts.trim()) {
        const sugg = await suggestConceptsFromContent(content);
        if (sugg) F("concepts", sugg);
      }
    } catch {
      setFetchMsg({
        type: "err",
        text: "Couldn't fetch that URL. Try pasting the content manually.",
      });
    }
    setFetching(false);
  };

  const publish = () => {
    if (!form.title.trim() || !form.content.trim()) return;
    const id = "a" + Date.now();
    const concepts = [
      ...new Set(
        form.concepts
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    setArticles((p) => [
      ...p,
      {
        id,
        title: form.title.trim(),
        goal: form.goal.trim(),
        concepts,
        content: form.content.trim(),
        url: form.url.trim(),
      },
    ]);
    setFlashId(id);
    setTimeout(() => setFlashId(null), 3500);
    setForm({ title: "", goal: "", concepts: "", content: "", url: "" });
    setFetchMsg(null);
  };

  const inp = (key, placeholder, multiline = false) => {
    const shared = {
      value: form[key],
      onChange: (e) => F(key, e.target.value),
      placeholder,
      style: {
        background: T.panel,
        border: `1px solid ${T.border}`,
        borderRadius: 8,
        padding: "9px 13px",
        color: T.text,
        fontSize: 14,
        outline: "none",
        fontFamily: "inherit",
        width: "100%",
        boxSizing: "border-box",
        ...(multiline
          ? { resize: "vertical", minHeight: 120, lineHeight: 1.8 }
          : {}),
      },
    };
    return multiline ? (
      <textarea
        {...shared}
        rows={7}
      />
    ) : (
      <input {...shared} />
    );
  };

  const sideBtn = (k, label) => (
    <button
      key={k}
      onClick={() => setTab(k)}
      style={{
        background: tab === k ? T.acS : "transparent",
        border: "none",
        padding: "11px 20px",
        textAlign: "left",
        cursor: "pointer",
        fontSize: 14,
        fontWeight: tab === k ? 500 : 400,
        color: tab === k ? T.acL : T.sub,
        borderLeft: `2px solid ${tab === k ? T.accent : "transparent"}`,
        transition: "all 0.15s",
        fontFamily: "inherit",
        width: "100%",
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* Sidebar */}
      <div
        style={{
          width: 192,
          background: T.panel,
          borderRight: `1px solid ${T.border}`,
          display: "flex",
          flexDirection: "column",
          paddingTop: 8,
          flexShrink: 0,
        }}
      >
        {sideBtn("articles", "Articles")}
        {sideBtn("map", "Concept map")}
        {sideBtn("students", "Students")}
        <div style={{ flex: 1 }} />
        <div
          style={{
            padding: "16px 20px",
            fontSize: 11,
            color: T.dim,
            lineHeight: 1.9,
          }}
        >
          {articles.length} article{articles.length !== 1 ? "s" : ""}
          <br />
          {articles.flatMap((a) => a.concepts).length} concepts
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, overflowY: "auto", padding: "30px 32px" }}>
        {/* ── ARTICLES ── */}
        {tab === "articles" && (
          <div
            style={{
              maxWidth: 700,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 4,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>
                Course articles
              </h2>
              <span style={{ fontSize: 12, color: T.sub }}>
                Students work through these in order
              </span>
            </div>

            {articles.map((a, i) => {
              const c = PAL[i % PAL.length];
              const fl = flashId === a.id;
              return (
                <div
                  key={a.id}
                  style={{
                    background: fl ? T.acS : T.card,
                    border: `1px solid ${fl ? T.accent : T.border}`,
                    borderRadius: 12,
                    padding: 20,
                    transition: "all 0.5s",
                  }}
                >
                  <div style={{ display: "flex", gap: 14 }}>
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        flexShrink: 0,
                        marginTop: 1,
                        background: c + "18",
                        border: `1.5px solid ${c}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        fontWeight: 700,
                        color: c,
                      }}
                    >
                      {i + 1}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          marginBottom: 5,
                          flexWrap: "wrap",
                        }}
                      >
                        <span style={{ fontSize: 15, fontWeight: 600 }}>
                          {a.title}
                        </span>
                        {a.url && (
                          <a
                            href={a.url}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              fontSize: 11,
                              color: T.sub,
                              textDecoration: "none",
                              background: T.bm,
                              borderRadius: 5,
                              padding: "1px 8px",
                            }}
                          >
                            ↗ source
                          </a>
                        )}
                        {fl && (
                          <span
                            style={{
                              fontSize: 10,
                              background: T.acS,
                              color: T.acL,
                              padding: "2px 8px",
                              borderRadius: 20,
                              border: `1px solid rgba(124,109,250,0.3)`,
                            }}
                          >
                            Live
                          </span>
                        )}
                      </div>
                      {a.goal && (
                        <div
                          style={{
                            fontSize: 13,
                            color: T.sub,
                            marginBottom: 10,
                          }}
                        >
                          {a.goal}
                        </div>
                      )}
                      <div
                        style={{ display: "flex", gap: 5, flexWrap: "wrap" }}
                      >
                        {a.concepts.map((con, ci) => (
                          <span
                            key={`${a.id}-${ci}-${con}`}
                            style={{
                              background: c + "18",
                              color: c,
                              borderRadius: 20,
                              padding: "2px 9px",
                              fontSize: 11,
                              fontWeight: 500,
                            }}
                          >
                            {con}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Add form */}
            <div
              style={{
                background: T.card,
                border: `1px dashed ${T.bm}`,
                borderRadius: 12,
                padding: 22,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: T.sub,
                  marginBottom: 16,
                }}
              >
                Add article
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                {inp("title", "Title")}
                {inp(
                  "goal",
                  "Learning goal — what should students walk away understanding?",
                )}

                {/* URL row */}
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={form.url}
                    onChange={(e) => F("url", e.target.value)}
                    placeholder="Article URL (paste to auto-fetch content + suggest concepts)"
                    onKeyDown={(e) => e.key === "Enter" && handleFetch()}
                    style={{
                      flex: 1,
                      background: T.panel,
                      border: `1px solid ${T.border}`,
                      borderRadius: 8,
                      padding: "9px 13px",
                      color: T.text,
                      fontSize: 14,
                      outline: "none",
                      fontFamily: "inherit",
                    }}
                  />
                  <button
                    onClick={handleFetch}
                    disabled={!form.url.trim() || fetching}
                    style={{
                      background: T.accent,
                      border: "none",
                      borderRadius: 8,
                      padding: "9px 18px",
                      color: "#fff",
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: fetching ? "wait" : "pointer",
                      opacity: !form.url.trim() || fetching ? 0.5 : 1,
                      fontFamily: "inherit",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {fetching ? "Fetching…" : "Fetch article"}
                  </button>
                </div>
                {fetchMsg && (
                  <div
                    style={{
                      fontSize: 12,
                      color: fetchMsg.type === "ok" ? T.green : T.amber,
                      padding: "6px 10px",
                      background: fetchMsg.type === "ok" ? T.gnS : T.amS,
                      borderRadius: 6,
                    }}
                  >
                    {fetchMsg.text}
                  </div>
                )}

                {inp(
                  "concepts",
                  "Key concepts (comma-separated — auto-filled from article)",
                )}
                {inp(
                  "content",
                  "Article content (auto-filled from URL, or paste manually)…",
                  true,
                )}

                <div>
                  <button
                    onClick={publish}
                    style={{
                      background: T.accent,
                      border: "none",
                      borderRadius: 8,
                      padding: "10px 24px",
                      color: "#fff",
                      fontSize: 14,
                      fontWeight: 500,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    Publish →
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── CONCEPT MAP ── */}
        {tab === "map" && (
          <div
            style={{
              maxWidth: 700,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 4,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>
                Concept map
              </h2>
              <span style={{ fontSize: 12, color: T.sub }}>
                Updates as you add articles
              </span>
            </div>
            <div
              style={{
                background: T.card,
                border: `1px solid ${T.border}`,
                borderRadius: 12,
                padding: 20,
                overflow: "hidden",
              }}
            >
              <ConceptMap articles={articles} />
            </div>
            <div
              style={{
                background: T.card,
                border: `1px solid ${T.border}`,
                borderRadius: 12,
                padding: 18,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  color: T.sub,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  marginBottom: 12,
                }}
              >
                All concepts · {articles.flatMap((a) => a.concepts).length}{" "}
                total
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {articles.length ? (
                  articles.flatMap((a, i) =>
                    a.concepts.map((c, ci) => (
                      <span
                        key={`${a.id}-${ci}-${c}`}
                        style={{
                          background: PAL[i % PAL.length] + "18",
                          color: PAL[i % PAL.length],
                          borderRadius: 20,
                          padding: "3px 11px",
                          fontSize: 11,
                        }}
                      >
                        {c}
                      </span>
                    )),
                  )
                ) : (
                  <span style={{ fontSize: 13, color: T.dim }}>
                    Add articles above
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── STUDENTS ── */}
        {tab === "students" && (
          <div
            style={{
              maxWidth: 760,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 600 }}>
              Student sessions
            </h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "204px minmax(0,1fr)",
                gap: 16,
                alignItems: "start",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div
                  style={{
                    background: T.card,
                    border: `1px dashed ${T.bm}`,
                    borderRadius: 11,
                    padding: 12,
                  }}
                >
                  <input
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addStudent()}
                    placeholder="Student name"
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      background: T.panel,
                      border: `1px solid ${T.border}`,
                      borderRadius: 8,
                      padding: "9px 10px",
                      color: T.text,
                      fontSize: 13,
                      outline: "none",
                      fontFamily: "inherit",
                      marginBottom: 8,
                    }}
                  />
                  <button
                    onClick={addStudent}
                    disabled={!studentName.trim()}
                    style={{
                      width: "100%",
                      background: T.accent,
                      border: "none",
                      borderRadius: 8,
                      padding: "8px 10px",
                      color: "#fff",
                      fontSize: 13,
                      fontWeight: 600,
                      opacity: studentName.trim() ? 1 : 0.45,
                      cursor: studentName.trim() ? "pointer" : "default",
                      fontFamily: "inherit",
                    }}
                  >
                    Add student
                  </button>
                </div>
                {!students.length && (
                  <div
                    style={{
                      background: T.card,
                      border: `1px solid ${T.border}`,
                      borderRadius: 11,
                      padding: 16,
                      color: T.dim,
                      fontSize: 13,
                      lineHeight: 1.6,
                    }}
                  >
                    No students yet.
                  </div>
                )}
                {students.map((s) => {
                  const sess = sessions[s.id] || {};
                  const cp = sess.conceptProgress || {};
                  const all = articles.flatMap((a) =>
                    a.concepts.map((c) => cp[a.id]?.[c] || 0),
                  );
                  const pct = all.length
                    ? Math.round(
                        (all.reduce((a, b) => a + b, 0) / all.length) * 100,
                      )
                    : 0;
                  const msgs = sess.messages || [];
                  const act = picked === s.id;
                  return (
                    <button
                      key={s.id}
                      onClick={() => setPicked(s.id)}
                      style={{
                        background: act ? T.acS : T.card,
                        border: `1px solid ${act ? T.accent : T.border}`,
                        borderRadius: 11,
                        padding: "14px 15px",
                        cursor: "pointer",
                        textAlign: "left",
                        color: T.text,
                        transition: "all 0.15s",
                        fontFamily: "inherit",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          marginBottom: 11,
                        }}
                      >
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: "50%",
                            background: T.acS,
                            border: `1px solid ${T.accent}`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 11,
                            fontWeight: 700,
                            color: T.acL,
                          }}
                        >
                          {getInitials(s.name)}
                        </div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500 }}>
                            {s.name}
                          </div>
                          <div
                            style={{ fontSize: 11, color: T.sub, marginTop: 2 }}
                          >
                            {msgs.length} messages · {pct}% understood
                          </div>
                        </div>
                      </div>
                      <div
                        style={{
                          height: 3,
                          background: T.border,
                          borderRadius: 2,
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: `${pct}%`,
                            background: `linear-gradient(90deg,${T.accent},${T.acL})`,
                            borderRadius: 2,
                            transition: "width 0.5s",
                          }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>

              <div
                style={{
                  background: T.card,
                  border: `1px solid ${T.border}`,
                  borderRadius: 12,
                  overflow: "hidden",
                }}
              >
                {!picked ? (
                  <div
                    style={{
                      padding: "56px 32px",
                      textAlign: "center",
                      color: T.sub,
                      fontSize: 14,
                    }}
                  >
                    Select a student to view their session
                  </div>
                ) : (
                  <>
                    <div
                      style={{
                        padding: "12px 18px",
                        borderBottom: `1px solid ${T.border}`,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 500 }}>
                        {students.find((s) => s.id === picked)?.name}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          color: T.green,
                          background: T.gnS,
                          padding: "2px 9px",
                          borderRadius: 20,
                        }}
                      >
                        ● Live
                      </span>
                    </div>
                    <div
                      style={{
                        maxHeight: 400,
                        overflowY: "auto",
                        padding: 18,
                        display: "flex",
                        flexDirection: "column",
                        gap: 12,
                      }}
                    >
                      {!sessions[picked]?.messages?.length ? (
                        <div
                          style={{
                            textAlign: "center",
                            color: T.dim,
                            fontSize: 13,
                            padding: 28,
                          }}
                        >
                          No activity yet
                        </div>
                      ) : (
                        sessions[picked].messages.map((m, i) => (
                          <Bubble
                            key={i}
                            msg={m}
                          />
                        ))
                      )}
                      <div ref={chatEndRef} />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Student view ───────────────────────────────────────────
function Student({ articles, account, session, onSession }) {
  const [idx, setIdx] = useState(session.currentArticleIndex || 0);
  const [phase, setPhase] = useState("reading"); // reading | learning
  const [msgs, setMsgs] = useState(session.messages || []);
  const [inp, setInp] = useState("");
  const [busy, setBusy] = useState(false);
  const [doneArts, setDoneArts] = useState(session.completedArticles || []);
  // cprog: { [articleId]: { [conceptName]: 0.0–1.0 } }
  const [cprog, setCProg] = useState(session.conceptProgress || {});
  const [convOver, setConvOver] = useState(false);
  const [finalScore, setFinalScore] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [level, setLevel] = useState("beginner");
  const [notes, setNotes] = useState([]);
  const [noteText, setNoteText] = useState("");
  const [showNotes, setShowNotes] = useState(false);

  const initIds = useRef(new Set(SEED.map((a) => a.id)));
  const endRef = useRef();

  const art = articles[idx];
  const COLOR = PAL[idx % PAL.length];

  useEffect(() => {
    setIdx(session.currentArticleIndex || 0);
    setMsgs(session.messages || []);
    setDoneArts(session.completedArticles || []);
    setCProg(session.conceptProgress || {});
    setPhase("reading");
    setConfirmed(false);
    setFinalScore(null);
    setConvOver(false);
  }, [account.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Overall progress: average across ALL concept scores
  const allScores = articles.flatMap((a) =>
    a.concepts.map((c) => cprog[a.id]?.[c] || 0),
  );
  const overallPct = allScores.length
    ? Math.round(
        (allScores.reduce((a, b) => a + b, 0) / allScores.length) * 100,
      )
    : 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  // Sync session state to professor view in real time
  useEffect(() => {
    onSession({
      messages: msgs,
      conceptProgress: cprog,
      completedArticles: doneArts,
      currentArticleIndex: idx,
    });
  }, [msgs, cprog, doneArts, idx]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildSystem = (a, lv, progress = {}) =>
    `You're a knowledgeable friend helping someone understand an article they just read. Your job is to teach through conversation, not to test or quiz them.

Tone: relaxed, warm, like a smart friend — max 1–2 sentences per response. Never sound like a professor.
Student level: ${lv}. ${lv === "beginner" ? "Use simple language and everyday analogies." : lv === "intermediate" ? "Use proper terminology, moderate depth." : "Go deep — nuanced questions, technical terms welcome."}
NEVER say "quiz", "test", "evaluate", or "assessment". This is just a conversation.

Article: "${a.title}"
Teaching goal: ${a.goal}
Concepts to cover: ${a.concepts.join(", ")}
Current concept progress memory: ${JSON.stringify(progress)}

How to teach:
- Every visible response must end with exactly one short guiding question.
- The question should move the student toward one or more concepts that are still below 0.8, while connecting naturally to what they just said.
- If the student interrupts with their own question, answer it first in 1 sentence, then ask one guiding follow-up that bridges back to the article concepts.
- Open with one casual question about the article's main idea.
- Based on the whole conversation and the progress memory, figure out what they get and what's fuzzy.
- Explain gaps with a real-world analogy (1 sentence max).
- Gently build understanding concept by concept through natural back-and-forth.
- When they clearly get something, move on — don't belabour it
- If they're wrong, just naturally correct without making it awkward
- Do not ask broad "any questions?" check-ins; ask specific questions that reveal understanding of the listed concepts.

After EVERY response you write, on a new line add EXACTLY:
EVAL:{"ConceptName":score} for ALL concepts, where score is 0.0–1.0
(0 = not yet discussed, 0.3 = mentioned but shaky, 0.6 = mostly gets it, 1.0 = nailed it)
Only use concept names from: ${a.concepts.join(", ")}
Scores must reflect cumulative demonstrated understanding from the entire conversation plus the progress memory, not just the most recent answer. Update them on every turn so the progress bar can change in real time.

When ALL concepts reach ≥ 0.8, still include the EVAL line, then append: DONE|score=N (N = your honest 1–10 overall understanding score)`;

  const updateCProg = (articleId, evalData) => {
    if (!evalData) return;
    setCProg((prev) => ({
      ...prev,
      [articleId]: {
        ...(prev[articleId] || {}),
        ...Object.fromEntries(
          Object.entries(evalData).map(([key, value]) => [
            key,
            Math.max(0, Math.min(1, Number(value) || 0)),
          ]),
        ),
      },
    }));
  };

  const startConversation = async () => {
    setPhase("learning");
    setBusy(true);
    try {
      const r = await callAI(
        [
          {
            role: "user",
            content: "Just finished reading — let's talk about it.",
          },
        ],
        buildSystem(art, level, cprog[art.id]),
      );
      updateCProg(art.id, parseEval(r));
      setMsgs([{ role: "assistant", content: cleanMsg(r) }]);
    } catch {
      setMsgs([{ role: "assistant", content: AI_RETRY_MESSAGE }]);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!inp.trim() || busy) return;
    const userMsg = { role: "user", content: inp.trim() };
    const history = [...msgs, userMsg];
    setMsgs(history);
    setInp("");
    setBusy(true);

    try {
      const r = await callAI(history, buildSystem(art, level, cprog[art.id]));
      const ev = parseEval(r);
      const doneMatch = r.match(/DONE\|score=(\d+)/);
      const cleanText = cleanMsg(r);

      // Always update concept progress from eval
      updateCProg(art.id, ev);

      if (doneMatch) {
        const sc = parseInt(doneMatch[1]);
        setFinalScore(sc);
        setMsgs((p) => [...p, { role: "assistant", content: cleanText }]);
        if (sc >= 6) {
          // Mark all concepts at 100%
          setCProg((p) => ({
            ...p,
            [art.id]: Object.fromEntries(art.concepts.map((c) => [c, 1])),
          }));
          setDoneArts((p) => (p.includes(art.id) ? p : [...p, art.id]));
          if (sc >= 8 && level === "beginner") setLevel("intermediate");
          if (sc >= 9 && level === "intermediate") setLevel("advanced");
        }
        setConvOver(true);
      } else {
        setMsgs((p) => [...p, { role: "assistant", content: cleanText }]);
      }
    } catch {
      setMsgs((p) => [...p, { role: "assistant", content: AI_RETRY_MESSAGE }]);
    } finally {
      setBusy(false);
    }
  };

  const goTo = (i) => {
    setIdx(i);
    setPhase("reading");
    setConfirmed(false);
    setMsgs([]);
    setFinalScore(null);
    setConvOver(false);
  };

  const saveNote = () => {
    if (!noteText.trim()) return;
    setNotes((p) => [
      { id: Date.now(), text: noteText.trim(), art: art?.title },
      ...p,
    ]);
    setNoteText("");
  };

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* ── Article stepper ── */}
      <div
        style={{
          background: T.panel,
          borderBottom: `1px solid ${T.border}`,
          padding: "0 24px",
          overflowX: "auto",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            minWidth: "max-content",
            height: 56,
          }}
        >
          {articles.map((a, i) => {
            const done = doneArts.includes(a.id);
            const active = i === idx;
            const locked = !done && i > idx;
            const c = PAL[i % PAL.length];
            const isNew = !initIds.current.has(a.id);
            // article-level progress (avg of its concepts)
            const artScores = a.concepts.map((con) => cprog[a.id]?.[con] || 0);
            const artPct = artScores.length
              ? Math.round(
                  (artScores.reduce((a, b) => a + b, 0) / artScores.length) *
                    100,
                )
              : 0;

            return (
              <div
                key={a.id}
                style={{ display: "flex", alignItems: "center" }}
              >
                <div
                  onClick={() => {
                    if (done || active) goTo(i);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "0 16px",
                    height: "100%",
                    opacity: locked ? 0.28 : 1,
                    cursor: done || active ? "pointer" : "default",
                    borderBottom: active
                      ? `2px solid ${c}`
                      : "2px solid transparent",
                    transition: "opacity 0.2s,border-color 0.2s",
                  }}
                >
                  {/* circle with mini arc progress */}
                  <div
                    style={{
                      position: "relative",
                      width: 24,
                      height: 24,
                      flexShrink: 0,
                    }}
                  >
                    <div
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        background: done ? c + "20" : active ? c + "18" : T.dim,
                        border: `1.5px solid ${done || active ? c : T.dim}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 10,
                        fontWeight: 700,
                        color: done || active ? c : T.sub,
                        transition: "all 0.3s",
                      }}
                    >
                      {done ? "✓" : active && artPct > 0 ? `${artPct}%` : i + 1}
                    </div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: active ? 600 : 400,
                        color: active ? T.text : done ? T.sub : T.dim,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {a.title.length > 24
                        ? a.title.slice(0, 23) + "…"
                        : a.title}
                    </div>
                    {active && (
                      <div style={{ fontSize: 10, color: c, marginTop: 1 }}>
                        {phase === "reading"
                          ? confirmed
                            ? "ready to discuss"
                            : "reading"
                          : convOver
                            ? "complete"
                            : "discussing"}
                      </div>
                    )}
                    {isNew && (
                      <div style={{ fontSize: 10, color: T.amber }}>new</div>
                    )}
                  </div>
                </div>
                {i < articles.length - 1 && (
                  <div
                    style={{
                      width: 20,
                      height: 1,
                      background:
                        i < idx ? PAL[i % PAL.length] + "55" : T.border,
                      flexShrink: 0,
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Concept progress chips ── */}
      <div
        style={{
          background: T.panel,
          borderBottom: `1px solid ${T.border}`,
          padding: "9px 24px",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 6,
          }}
        >
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", flex: 1 }}>
            {articles.flatMap((a, ai) =>
              a.concepts.map((c, ci) => (
                <ConceptChip
                  key={`${a.id}-${ci}-${c}`}
                  label={c}
                  color={PAL[ai % PAL.length]}
                  score={cprog[a.id]?.[c] || 0}
                />
              )),
            )}
          </div>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: T.acL,
              marginLeft: 12,
              whiteSpace: "nowrap",
            }}
          >
            {overallPct}%
          </span>
        </div>
        <div
          style={{
            height: 4,
            background: T.border,
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${overallPct}%`,
              background: `linear-gradient(90deg,${T.accent},${T.acL})`,
              borderRadius: 2,
              transition: "width 0.8s cubic-bezier(0.4,0,0.2,1)",
            }}
          />
        </div>
      </div>

      {/* ── Main + notes ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {!art ? (
            <div
              style={{
                padding: 64,
                textAlign: "center",
                color: T.sub,
                fontSize: 14,
              }}
            >
              No articles yet — check back soon.
            </div>
          ) : phase === "reading" ? (
            /* ── READING PHASE ── */
            <div
              style={{
                maxWidth: 700,
                margin: "0 auto",
                padding: "38px 28px 60px",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: T.sub,
                  letterSpacing: 3,
                  textTransform: "uppercase",
                  marginBottom: 12,
                }}
              >
                Article {idx + 1} of {articles.length}
              </div>
              <h2
                style={{
                  margin: "0 0 8px",
                  fontSize: 28,
                  fontWeight: 700,
                  letterSpacing: "-0.8px",
                }}
              >
                {art.title}
              </h2>
              {art.url && (
                <a
                  href={art.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontSize: 12,
                    color: T.sub,
                    display: "inline-block",
                    marginBottom: 16,
                    textDecoration: "none",
                    background: T.card,
                    border: `1px solid ${T.border}`,
                    borderRadius: 6,
                    padding: "3px 10px",
                  }}
                >
                  ↗ Original article
                </a>
              )}
              {art.goal && (
                <div
                  style={{
                    background: COLOR + "0d",
                    border: `1px solid ${COLOR}28`,
                    borderRadius: 9,
                    padding: "11px 16px",
                    marginBottom: 30,
                    fontSize: 13,
                    color: COLOR,
                    lineHeight: 1.65,
                  }}
                >
                  🎯 {art.goal}
                </div>
              )}
              <div
                style={{ fontSize: 15, lineHeight: 1.95, color: T.text }}
                dangerouslySetInnerHTML={{
                  __html: art.content
                    .replace(
                      /\*\*(.*?)\*\*/g,
                      `<strong style="color:${COLOR};font-weight:600">$1</strong>`,
                    )
                    .replace(/\n/g, "<br/>"),
                }}
              />
              <div
                style={{
                  marginTop: 48,
                  display: "flex",
                  gap: 14,
                  alignItems: "center",
                }}
              >
                {!confirmed ? (
                  <button
                    onClick={() => setConfirmed(true)}
                    style={{
                      background: COLOR,
                      border: "none",
                      borderRadius: 9,
                      padding: "12px 32px",
                      color: "#fff",
                      fontSize: 15,
                      fontWeight: 600,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    Done reading
                  </button>
                ) : (
                  <>
                    <button
                      onClick={startConversation}
                      style={{
                        background: T.green,
                        border: "none",
                        borderRadius: 9,
                        padding: "12px 32px",
                        color: "#fff",
                        fontSize: 15,
                        fontWeight: 600,
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      Let's talk about it →
                    </button>
                    <span style={{ fontSize: 13, color: T.sub }}>
                      Just a conversation — no pressure.
                    </span>
                  </>
                )}
              </div>
            </div>
          ) : (
            /* ── LEARNING PHASE ── */
            <div
              style={{
                maxWidth: 660,
                margin: "0 auto",
                padding: "28px 28px 60px",
              }}
            >
              <div style={{ fontSize: 12, color: T.sub, marginBottom: 18 }}>
                {art.title}
                <span style={{ color: T.dim }}> · {level}</span>
              </div>

              <div
                style={{ display: "flex", flexDirection: "column", gap: 13 }}
              >
                {msgs.map((m, i) => (
                  <Bubble
                    key={i}
                    msg={m}
                    accentColor={COLOR}
                  />
                ))}
                {busy && <TypingDots />}
                <div ref={endRef} />
              </div>

              {convOver && (
                <div
                  style={{
                    marginTop: 24,
                    padding: 20,
                    borderRadius: 12,
                    background: finalScore >= 6 ? T.gnS : T.amS,
                    border: `1px solid ${finalScore >= 6 ? T.green : T.amber}40`,
                  }}
                >
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 600,
                      marginBottom: 12,
                      color: finalScore >= 6 ? T.green : T.amber,
                    }}
                  >
                    {finalScore >= 6
                      ? `${finalScore}/10 — you've got it!`
                      : `${finalScore}/10 — worth another look`}
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    {finalScore >= 6 && idx + 1 < articles.length && (
                      <button
                        onClick={() => goTo(idx + 1)}
                        style={{
                          background: T.green,
                          border: "none",
                          borderRadius: 8,
                          padding: "9px 22px",
                          color: "#fff",
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        Next article →
                      </button>
                    )}
                    {finalScore >= 6 && idx + 1 >= articles.length && (
                      <span
                        style={{
                          fontSize: 15,
                          color: T.green,
                          fontWeight: 700,
                        }}
                      >
                        All done! 🎉
                      </span>
                    )}
                    {finalScore < 6 && (
                      <button
                        onClick={() => goTo(idx)}
                        style={{
                          background: T.accent,
                          border: "none",
                          borderRadius: 8,
                          padding: "9px 22px",
                          color: "#fff",
                          fontSize: 13,
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        Re-read →
                      </button>
                    )}
                  </div>
                </div>
              )}

              {!convOver && (
                <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
                  <input
                    value={inp}
                    onChange={(e) => setInp(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && !e.shiftKey && send()
                    }
                    placeholder="Reply…"
                    disabled={busy}
                    style={{
                      flex: 1,
                      background: T.panel,
                      border: `1px solid ${T.bm}`,
                      borderRadius: 9,
                      padding: "11px 15px",
                      color: T.text,
                      fontSize: 14,
                      outline: "none",
                      fontFamily: "inherit",
                    }}
                  />
                  <button
                    onClick={send}
                    disabled={busy}
                    style={{
                      background: COLOR,
                      border: "none",
                      borderRadius: 9,
                      padding: "11px 22px",
                      color: "#fff",
                      fontSize: 14,
                      fontWeight: 500,
                      cursor: "pointer",
                      opacity: busy ? 0.55 : 1,
                      fontFamily: "inherit",
                    }}
                  >
                    Send
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Notes panel ── */}
        <div
          style={{
            width: showNotes ? 256 : 46,
            borderLeft: `1px solid ${T.border}`,
            background: T.panel,
            display: "flex",
            flexDirection: "column",
            transition: "width 0.22s ease",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setShowNotes((n) => !n)}
            title={showNotes ? "Close" : "Notes"}
            style={{
              height: 48,
              background: "transparent",
              border: "none",
              borderBottom: `1px solid ${T.border}`,
              cursor: "pointer",
              color: T.sub,
              fontSize: 13,
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              justifyContent: showNotes ? "space-between" : "center",
              padding: showNotes ? "0 16px" : 0,
              whiteSpace: "nowrap",
            }}
          >
            {showNotes ? (
              <>
                <span style={{ fontSize: 14, fontWeight: 500, color: T.text }}>
                  Notes
                </span>
                <span style={{ fontSize: 20, color: T.dim }}>×</span>
              </>
            ) : (
              <span style={{ fontSize: 18 }}>📝</span>
            )}
          </button>
          {showNotes && (
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder={`Note on "${art?.title}"…`}
                rows={3}
                style={{
                  background: T.card,
                  border: `1px solid ${T.border}`,
                  borderRadius: 8,
                  padding: "9px 10px",
                  color: T.text,
                  fontSize: 12,
                  outline: "none",
                  resize: "none",
                  fontFamily: "inherit",
                  lineHeight: 1.65,
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
              <button
                onClick={saveNote}
                style={{
                  background: T.accent,
                  border: "none",
                  borderRadius: 7,
                  padding: "7px 0",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  width: "100%",
                }}
              >
                Save
              </button>
              {notes.map((n) => (
                <div
                  key={n.id}
                  style={{
                    background: T.card,
                    border: `1px solid ${T.border}`,
                    borderRadius: 8,
                    padding: "10px 11px",
                  }}
                >
                  <div style={{ fontSize: 10, color: T.dim, marginBottom: 4 }}>
                    {n.art}
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.65 }}>{n.text}</div>
                </div>
              ))}
              {!notes.length && (
                <div
                  style={{
                    fontSize: 12,
                    color: T.dim,
                    textAlign: "center",
                    paddingTop: 16,
                  }}
                >
                  No notes yet
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes dot{0%,100%{opacity:.2;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}`}</style>
    </div>
  );
}

// ── App root ───────────────────────────────────────────────
export default function App() {
  const [currentAccountId, setCurrentAccountId] = useState(null);
  const [appState, setAppState] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.accounts)) {
        return {
          accounts: saved.accounts,
          articles: saved.articles || SEED,
          sessions: saved.sessions || {},
        };
      }
    } catch {
      // Start fresh if local storage contains invalid data.
    }
    return { accounts: [], articles: SEED, sessions: {} };
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
  }, [appState]);

  useEffect(() => {
    const syncFromStorage = (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        const saved = JSON.parse(event.newValue);
        if (saved && Array.isArray(saved.accounts)) setAppState(saved);
      } catch {
        // Ignore malformed storage events.
      }
    };
    window.addEventListener("storage", syncFromStorage);
    return () => window.removeEventListener("storage", syncFromStorage);
  }, []);

  const accounts = appState.accounts;
  const articles = appState.articles;
  const sessions = appState.sessions;
  const currentAccount = accounts.find((a) => a.id === currentAccountId);
  const students = accounts.filter((a) => a.role === "student");

  const setArticles = useCallback((next) => {
    setAppState((prev) => ({
      ...prev,
      articles: typeof next === "function" ? next(prev.articles) : next,
    }));
  }, []);

  const createAccount = useCallback(({ name, role }) => {
    const account = { id: makeId(role === "student" ? "s" : "p"), name, role };
    setAppState((prev) => ({
      ...prev,
      accounts: [...prev.accounts, account],
      sessions:
        role === "student"
          ? { ...prev.sessions, [account.id]: emptySession() }
          : prev.sessions,
    }));
    setCurrentAccountId(account.id);
    return account;
  }, []);

  const addStudent = useCallback((name) => {
    const student = { id: makeId("s"), name, role: "student" };
    setAppState((prev) => ({
      ...prev,
      accounts: [...prev.accounts, student],
      sessions: { ...prev.sessions, [student.id]: emptySession() },
    }));
    return student;
  }, []);

  const updSession = useCallback((id, data) => {
    setAppState((prev) => ({
      ...prev,
      sessions: {
        ...prev.sessions,
        [id]: { ...(prev.sessions[id] || emptySession()), ...data },
      },
    }));
  }, []);

  if (!currentAccount) {
    return (
      <AccountLogin
        accounts={accounts}
        onLogin={setCurrentAccountId}
        onCreateAccount={createAccount}
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: T.bg,
        color: T.text,
        fontFamily: "Inter,system-ui,-apple-system,sans-serif",
      }}
    >
      <nav
        style={{
          height: 52,
          background: T.panel,
          borderBottom: `1px solid ${T.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 22px",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              background: T.accent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 15,
              color: "#fff",
              fontWeight: 700,
              boxShadow: `0 0 16px ${T.accent}50`,
            }}
          >
            ✦
          </div>
          <span
            style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.3px" }}
          >
            Learning Studio
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              fontSize: 12,
              color: T.sub,
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 20,
              padding: "3px 12px",
            }}
          >
            {currentAccount.name}
            <span style={{ color: T.dim, textTransform: "capitalize" }}>
              {" "}
              · {currentAccount.role}
            </span>
          </span>
          <button
            onClick={() => setCurrentAccountId(null)}
            style={{
              background: "transparent",
              border: `1px solid ${T.border}`,
              borderRadius: 7,
              padding: "5px 12px",
              color: T.sub,
              fontSize: 12,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Switch
          </button>
        </div>
      </nav>
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {currentAccount.role === "professor" ? (
          <Professor
            articles={articles}
            setArticles={setArticles}
            sessions={sessions}
            students={students}
            onAddStudent={addStudent}
          />
        ) : (
          <Student
            articles={articles}
            account={currentAccount}
            session={sessions[currentAccount.id] || emptySession()}
            onSession={(d) => updSession(currentAccount.id, d)}
          />
        )}
      </div>
    </div>
  );
}
