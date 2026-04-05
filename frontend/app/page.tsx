"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/hooks/useAuth";
import {
  listKBs,
  createKB,
  streamQuery,
  uploadDocument,
  listDocuments,
  deleteDocument,
} from "@/lib/api";
import type { Source, Document } from "@/lib/types";

// ── Toast ─────────────────────────────────────────────────────────────────────

type Toast = { id: number; message: string; type: "success" | "error" | "info" };

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const add = useCallback((message: string, type: Toast["type"] = "info") => {
    const id = ++counter.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  return { toasts, add };
}

function ToastContainer({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  const colors: Record<Toast["type"], string> = {
    success: "bg-green-800 border-green-600 text-green-100",
    error:   "bg-red-900   border-red-700   text-red-100",
    info:    "bg-gray-800  border-gray-600  text-gray-100",
  };
  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`border rounded px-4 py-2 text-sm shadow-lg animate-fade-in ${colors[t.type]}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ── Confidence bar ────────────────────────────────────────────────────────────

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const [label, barColor, labelColor] =
    pct > 75 ? ["High",   "bg-green-500",  "text-green-400"]  :
    pct > 50 ? ["Medium", "bg-yellow-500", "text-yellow-400"] :
               ["Low",    "bg-red-500",    "text-red-400"];
  return (
    <div className="mt-2 flex items-center gap-2">
      <span className={`text-xs font-medium w-12 ${labelColor}`}>{label}</span>
      <div className="flex-1 bg-gray-700 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-gray-400 tabular-nums w-8 text-right">{pct}%</span>
    </div>
  );
}

// ── Collapsible sources ───────────────────────────────────────────────────────

function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <div className="mt-2 border-t border-gray-700 pt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1"
      >
        <span>{open ? "▾" : "▸"}</span>
        {sources.length} source{sources.length !== 1 ? "s" : ""}
      </button>
      {open && (
        <ul className="mt-1 space-y-1">
          {sources.map((s, j) => (
            <li
              key={j}
              className={`text-xs text-gray-300 rounded px-2 py-1 ${
                j === 0
                  ? "bg-blue-950 border-l-2 border-blue-500"
                  : "bg-[#0f1117]"
              }`}
            >
              {j === 0 && (
                <span className="text-blue-400 font-medium mr-1.5">Top</span>
              )}
              {(s as any).source && (
                <span className="text-gray-500 mr-1">[{(s as any).source}]</span>
              )}
              {s.text.length > 120 ? s.text.slice(0, 120) + "…" : s.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Home() {
  const { token, login, loading: authLoading, error: authError } = useAuth();
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");

  // KB + docs
  const [kbId, setKbId] = useState<string | null>(null);
  const [docs, setDocs] = useState<Document[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const autoSelectedRef = useRef<Set<string>>(new Set());

  // Chat
  const [messages, setMessages] = useState<{
    role: string;
    text: string;
    confidence?: number;
    sources?: Source[];
    streaming?: boolean;
    fallback?: boolean;
    query?: string;
  }[]>([]);
  const [input, setInput]       = useState("");
  const [sending, setSending]   = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Toasts
  const { toasts, add: toast } = useToast();

  // ── KB init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const kbs = await listKBs();
        const kb = kbs.length > 0 ? kbs[0] : await createKB("Default");
        setKbId(kb.id);
        setDocs(await listDocuments(kb.id));
      } catch (e) {
        toast("Could not initialize knowledge base.", "error");
      }
    })();
  }, [token]);

  // ── Auto-select newly indexed docs (first time only) ───────────────────────
  useEffect(() => {
    const newlyIndexed = docs.filter(
      (d) => d.status === "indexed" && !autoSelectedRef.current.has(d.id)
    );
    if (newlyIndexed.length === 0) return;
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      newlyIndexed.forEach((d) => next.add(d.id));
      return next;
    });
    newlyIndexed.forEach((d) => autoSelectedRef.current.add(d.id));
  }, [docs]);

  // ── Poll while any doc is processing ───────────────────────────────────────
  useEffect(() => {
    if (!kbId) return;
    const inProgress = docs.some(
      (d) => d.status === "pending" || d.status === "processing"
    );
    if (!inProgress) return;
    const timer = setTimeout(async () => {
      try { setDocs(await listDocuments(kbId)); } catch {}
    }, 3000);
    return () => clearTimeout(timer);
  }, [kbId, docs]);

  // ── Auto-scroll to bottom on new messages ──────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Auth screen ─────────────────────────────────────────────────────────────
  if (!token) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0f1117] text-white">
        <div className="flex flex-col gap-3 w-80">
          <h1 className="text-xl font-semibold text-center">Sign In</h1>
          <input
            type="email"
            className="bg-[#1a1d27] border border-gray-700 rounded px-3 py-2 outline-none"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            className="bg-[#1a1d27] border border-gray-700 rounded px-3 py-2 outline-none"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login(email, password)}
          />
          {authError && <p className="text-red-400 text-sm">{authError}</p>}
          <button
            className="bg-blue-600 hover:bg-blue-700 rounded px-4 py-2 disabled:opacity-50"
            disabled={authLoading}
            onClick={() => login(email, password)}
          >
            {authLoading ? "Signing in..." : "Sign In"}
          </button>
        </div>
      </div>
    );
  }

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !kbId) return;
    setUploading(true);
    try {
      await uploadDocument(kbId, file);
      toast(`"${file.name}" uploaded`, "success");
      setDocs(await listDocuments(kbId));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Upload failed", "error");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async (doc: Document) => {
    if (!kbId) return;
    try {
      await deleteDocument(kbId, doc.id);
      setSelectedDocs((prev) => { const n = new Set(prev); n.delete(doc.id); return n; });
      autoSelectedRef.current.delete(doc.id);
      setDocs(await listDocuments(kbId));
      toast(`"${doc.filename}" deleted`, "info");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "error");
    }
  };

  // ── Streaming send ───────────────────────────────────────────────────────────
  const FALLBACK_RE = /don['\u2019]t have enough information/i;

  // replaceIdx: when set, replaces that message index (Regenerate) instead of appending
  const sendQuery = async (text: string, replaceIdx?: number) => {
    if (!text || !kbId || sending) return;

    if (replaceIdx === undefined) {
      setMessages((prev) => [...prev, { role: "user", text }]);
    }
    setSending(true);

    setMessages((prev) => {
      const next = [...prev];
      const placeholder = { role: "assistant", text: "", streaming: true };
      if (replaceIdx !== undefined) next[replaceIdx] = placeholder;
      else next.push(placeholder);
      return next;
    });

    try {
      const docIds = docs
        .filter((d) => d.status === "indexed" && selectedDocs.has(d.id))
        .map((d) => d.id);

      let accumulated = "";
      let finalSources: Source[] | undefined;
      let finalConfidence: number | undefined;

      for await (const chunk of streamQuery(kbId, text, docIds)) {
        // extract metadata BEFORE breaking — the done event carries sources + confidence
        if (chunk.sources)    finalSources    = chunk.sources;
        if (chunk.confidence !== undefined) finalConfidence = chunk.confidence;
        if (chunk.done) break;
        if (chunk.token) {
          accumulated += chunk.token;
          setMessages((prev) => {
            const next = [...prev];
            const idx = replaceIdx ?? next.length - 1;
            next[idx] = { role: "assistant", text: accumulated, streaming: true };
            return next;
          });
        }
      }

      const isFallback = FALLBACK_RE.test(accumulated);
      if (isFallback) finalConfidence = 0;

      setMessages((prev) => {
        const next = [...prev];
        const idx = replaceIdx ?? next.length - 1;
        next[idx] = {
          role: "assistant",
          text: accumulated,
          confidence: finalConfidence,
          sources: finalSources,
          streaming: false,
          fallback: isFallback,
          query: text,
        };
        return next;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Request failed";
      setMessages((prev) => {
        const next = [...prev];
        const idx = replaceIdx ?? next.length - 1;
        next[idx] = { role: "assistant", text: `Error: ${msg}` };
        return next;
      });
      toast(msg, "error");
    } finally {
      setSending(false);
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendQuery(text);
  };

  const copyText = (text: string, idx: number) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    });
  };

  const hasIndexedDocs = docs.some((d) => d.status === "indexed");
  const hasSelection   = docs.some((d) => d.status === "indexed" && selectedDocs.has(d.id));

  // ── Status badge ─────────────────────────────────────────────────────────────
  const statusBadge = (status: string) => {
    const styles: Record<string, string> = {
      indexed:    "bg-green-900 text-green-300",
      processing: "bg-yellow-900 text-yellow-300",
      pending:    "bg-gray-700  text-gray-300",
      failed:     "bg-red-900   text-red-300",
      error:      "bg-red-900   text-red-300",
    };
    return (
      <span className={`text-xs px-1.5 py-0.5 rounded ${styles[status] ?? styles.pending}`}>
        {status}
      </span>
    );
  };

  // ── Layout ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-[#0f1117] text-white">
      <ToastContainer toasts={toasts} />

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <aside className="w-64 flex-shrink-0 border-r border-gray-800 flex flex-col p-3 gap-3">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
          Documents
        </h2>

        {/* Upload */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">Upload .txt file</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt"
            disabled={!kbId || uploading}
            onChange={handleUpload}
            className="text-xs text-gray-300 file:mr-2 file:py-1 file:px-2
                       file:rounded file:border-0 file:bg-blue-600 file:text-white
                       file:text-xs file:cursor-pointer disabled:opacity-50 cursor-pointer"
          />
          {uploading && <p className="text-xs text-gray-400 italic">Uploading…</p>}
        </div>

        {/* Document list */}
        <div className="flex-1 overflow-y-auto flex flex-col gap-1">
          {!kbId && <p className="text-xs text-gray-500 italic">Initializing…</p>}
          {kbId && docs.length === 0 && (
            <p className="text-xs text-gray-500 italic">No documents yet.</p>
          )}
          {docs.map((doc) => {
            const isIndexed = doc.status === "indexed";
            const isChecked = selectedDocs.has(doc.id);
            return (
              <div
                key={doc.id}
                className={`bg-[#1a1d27] rounded px-2 py-1.5 flex items-start gap-2
                  ${isIndexed ? "hover:bg-[#22263a]" : "opacity-60"}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 accent-blue-500 flex-shrink-0"
                  checked={isChecked}
                  disabled={!isIndexed}
                  onChange={() => {
                    setSelectedDocs((prev) => {
                      const next = new Set(prev);
                      next.has(doc.id) ? next.delete(doc.id) : next.add(doc.id);
                      return next;
                    });
                  }}
                />
                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <span className="text-xs text-gray-200 truncate" title={doc.filename}>
                    {doc.filename}
                  </span>
                  {statusBadge(doc.status)}
                </div>
                <button
                  onClick={() => handleDelete(doc)}
                  title="Delete document"
                  className="text-gray-600 hover:text-red-400 text-xs flex-shrink-0 mt-0.5 leading-none"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      {/* ── Chat ────────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {!hasIndexedDocs && kbId && (
            <p className="text-gray-500 text-sm text-center pt-8">
              Upload a document to start chatting.
            </p>
          )}
          {hasIndexedDocs && !hasSelection && (
            <p className="text-gray-500 text-sm text-center pt-8">
              Select at least one document to query.
            </p>
          )}

          {messages.map((m, i) => (
            <div
              key={i}
              className={`max-w-xl px-4 py-2 rounded ${
                m.role === "user" ? "ml-auto bg-blue-700" : "bg-[#1a1d27]"
              }`}
            >
              {/* Copy button — shown after streaming finishes */}
              {m.role === "assistant" && !m.streaming && (
                <div className="flex justify-end mb-1">
                  <button
                    onClick={() => copyText(m.text, i)}
                    className="text-xs text-gray-600 hover:text-gray-300 transition-colors"
                  >
                    {copiedIdx === i ? "Copied!" : "Copy"}
                  </button>
                </div>
              )}

              {m.role === "assistant" && m.fallback ? (
                <p className="text-yellow-400 text-sm flex items-center gap-1.5">
                  <span>⚠</span> No relevant information found in selected documents.
                </p>
              ) : (
                <p className="whitespace-pre-wrap">
                  {m.text}
                  {/* Blinking block cursor while streaming */}
                  {m.streaming && (
                    <span className="animate-blink text-gray-400 ml-0.5">▍</span>
                  )}
                </p>
              )}

              {m.role === "assistant" && !m.streaming && m.confidence !== undefined && (
                <ConfidenceBar value={m.confidence} />
              )}

              {m.role === "assistant" && !m.streaming && m.sources && m.sources.length > 0 && (
                <>
                  <p className="mt-2 text-xs text-gray-500">
                    Using {m.sources.length} source{m.sources.length !== 1 ? "s" : ""}
                  </p>
                  <Sources sources={m.sources} />
                </>
              )}

              {m.role === "assistant" && !m.streaming && m.query && (
                <button
                  onClick={() => sendQuery(m.query!, i)}
                  disabled={sending}
                  className="mt-2 text-xs text-gray-500 hover:text-gray-300 disabled:opacity-40"
                >
                  ↻ Regenerate
                </button>
              )}
            </div>
          ))}

          {/* anchor for auto-scroll */}
          <div ref={bottomRef} />
        </div>

        <div className="flex gap-2 p-4 border-t border-gray-800">
          <input
            className="flex-1 bg-[#1a1d27] border border-gray-700 rounded px-3 py-2 outline-none disabled:opacity-50"
            placeholder={
              !hasIndexedDocs ? "Upload a document first…" :
              !hasSelection   ? "Select a document first…" :
                                "Ask something…"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
            disabled={!hasSelection || sending}
          />
          <button
            className="bg-blue-600 hover:bg-blue-700 rounded px-4 py-2 disabled:opacity-50"
            onClick={send}
            disabled={!hasSelection || sending}
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
