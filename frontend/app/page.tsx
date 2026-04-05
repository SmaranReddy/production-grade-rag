"use client";

import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";

export default function Home() {
  const { token, login, loading: authLoading, error: authError } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [messages, setMessages] = useState<{ role: string; text: string }[]>([]);
  const [input, setInput] = useState("");

  if (!token) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0f1117] text-white">
        <div className="flex flex-col gap-3 w-80">
          <h1 className="text-xl font-semibold text-center">Sign In</h1>
          <input
            className="bg-[#1a1d27] border border-gray-700 rounded px-3 py-2 outline-none"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
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
            onClick={() => login(username, password)}
          >
            {authLoading ? "Signing in..." : "Sign In"}
          </button>
        </div>
      </div>
    );
  }

  const send = () => {
    const text = input.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
  };

  return (
    <div className="flex flex-col h-screen bg-[#0f1117] text-white">
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={`max-w-xl px-4 py-2 rounded ${m.role === "user" ? "ml-auto bg-blue-700" : "bg-[#1a1d27]"}`}>
            {m.text}
          </div>
        ))}
      </div>
      <div className="flex gap-2 p-4 border-t border-gray-800">
        <input
          className="flex-1 bg-[#1a1d27] border border-gray-700 rounded px-3 py-2 outline-none"
          placeholder="Ask something..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button
          className="bg-blue-600 hover:bg-blue-700 rounded px-4 py-2"
          onClick={send}
        >
          Send
        </button>
      </div>
    </div>
  );
}
