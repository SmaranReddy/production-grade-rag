"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { listKBs, createKB, queryKB, uploadDocument, listDocuments } from "@/lib/api";
import type { Source, Document } from "@/lib/types";

export default function Home() {
  const { token, login, loading: authLoading, error: authError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // KB + docs
  const [kbId, setKbId] = useState<string | null>(null);
  const [docs, setDocs] = useState<Document[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Tracks which doc IDs are selected for querying (default: all indexed)
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  // Remembers docs already auto-selected so manual deselection isn't overridden on re-render
  const autoSelectedRef = useRef<Set<string>>(new Set());

  // Chat
  const [messages, setMessages] = useState<{
    role: string;
    text: string;
    confidence?: number;
    sources?: Source[];
  }[]>([]);
  const [input, setInput] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // After login: resolve or create KB, then load its documents
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const kbs = await listKBs();
        const kb = kbs.length > 0 ? kbs[0] : await createKB("Default");
        console.log("[KB]", kbs.length > 0 ? "Using" : "Created", kb.id);
        setKbId(kb.id);
        setDocs(await listDocuments(kb.id));
      } catch (e) {
        console.error("[KB] init failed:", e);
        setChatError("Could not initialize knowledge base.");
      }
    })();
  }, [token]);

  // Auto-select a doc the first time it reaches "indexed" status
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

  // Poll every 3 s while any document is still processing
  useEffect(() => {
    if (!kbId) return;
    const inProgress = docs.some(
      (d) => d.status === "pending" || d.status === "processing"
    );
    if (!inProgress) return;
    const timer = setTimeout(async () => {
      try {
        setDocs(await listDocuments(kbId));
      } catch {}
    }, 3000);
    return () => clearTimeout(timer);
  }, [kbId, docs]);

  // ── Auth screen ──────────────────────────────────────────────────────────────
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
    setUploadError(null);
    setUploadSuccess(null);

    try {
      await uploadDocument(kbId, file);
      setUploadSuccess(`"${file.name}" uploaded`);
      setDocs(await listDocuments(kbId));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !kbId || sending) return;

    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setSending(true);
    setChatError(null);

    console.log("[Query] POST /kb/" + kbId + "/query  body:", { query: text });

    try {
      const docIds = docs
        .filter((d) => d.status === "indexed" && selectedDocs.has(d.id))
        .map((d) => d.id);
      console.log("[Query] selected doc_ids:", docIds);
      const res = await queryKB(kbId, text, docIds);
      console.log("[Query] Response:", res);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: res.answer,
          confidence: res.confidence,
          sources: res.sources,
        },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Request failed";
      console.error("[Query] Error:", msg);
      setChatError(msg);
    } finally {
      setSending(false);
    }
  };

  const hasIndexedDocs = docs.some((d) => d.status === "indexed");
  const hasSelection = docs.some((d) => d.status === "indexed" && selectedDocs.has(d.id));

  // ── Status badge helper ───────────────────────────────────────────────────────
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

  // ── Main layout ───────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-[#0f1117] text-white">

      {/* ── Sidebar: documents ─────────────────────────────────────────────── */}
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
          {uploading && (
            <p className="text-xs text-gray-400 italic">Uploading...</p>
          )}
          {uploadSuccess && (
            <p className="text-xs text-green-400">{uploadSuccess}</p>
          )}
          {uploadError && (
            <p className="text-xs text-red-400">{uploadError}</p>
          )}
        </div>

        {/* Document list */}
        <div className="flex-1 overflow-y-auto flex flex-col gap-1">
          {!kbId && (
            <p className="text-xs text-gray-500 italic">Initializing...</p>
          )}
          {kbId && docs.length === 0 && (
            <p className="text-xs text-gray-500 italic">No documents yet.</p>
          )}
          {docs.map((doc) => {
            const isIndexed = doc.status === "indexed";
            const isChecked = selectedDocs.has(doc.id);
            return (
              <label
                key={doc.id}
                className={`bg-[#1a1d27] rounded px-2 py-1.5 flex items-start gap-2 cursor-pointer
                  ${isIndexed ? "hover:bg-[#22263a]" : "opacity-60 cursor-default"}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 accent-blue-500"
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
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-xs text-gray-200 truncate" title={doc.filename}>
                    {doc.filename}
                  </span>
                  {statusBadge(doc.status)}
                </div>
              </label>
            );
          })}
        </div>
      </aside>

      {/* ── Chat ───────────────────────────────────────────────────────────── */}
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
              <p>{m.text}</p>

              {m.role === "assistant" && m.confidence !== undefined && (
                <p className="mt-2 text-xs text-gray-400">
                  Confidence: {m.confidence.toFixed(2)}
                </p>
              )}

              {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                <div className="mt-2 border-t border-gray-700 pt-2">
                  <p className="text-xs text-gray-400 mb-1">Sources:</p>
                  <ul className="space-y-1">
                    {m.sources.map((s, j) => (
                      <li
                        key={j}
                        className="text-xs text-gray-300 bg-[#0f1117] rounded px-2 py-1"
                      >
                        {(s as any).source && (
                          <span className="text-gray-500 mr-1">
                            [{(s as any).source}]
                          </span>
                        )}
                        {s.text.length > 120 ? s.text.slice(0, 120) + "…" : s.text}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}

          {sending && (
            <div className="max-w-xl px-4 py-2 rounded bg-[#1a1d27] text-gray-400 italic">
              Thinking...
            </div>
          )}
          {chatError && (
            <p className="text-red-400 text-sm text-center">{chatError}</p>
          )}
        </div>

        <div className="flex gap-2 p-4 border-t border-gray-800">
          <input
            className="flex-1 bg-[#1a1d27] border border-gray-700 rounded px-3 py-2 outline-none disabled:opacity-50"
            placeholder={
              !hasIndexedDocs ? "Upload a document first..." :
              !hasSelection   ? "Select a document first..." :
                                "Ask something..."
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            disabled={!hasSelection || sending}
          />
          <button
            className="bg-blue-600 hover:bg-blue-700 rounded px-4 py-2 disabled:opacity-50"
            onClick={send}
            disabled={!hasSelection || sending}
          >
            {sending ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
