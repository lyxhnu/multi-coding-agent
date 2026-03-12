"use client";

import Editor from "@monaco-editor/react";
import { Save } from "lucide-react";

import { useAppStore } from "@/lib/store";

export function InspectorPanel() {
  const {
    editableFiles,
    runFiles,
    inspectorPath,
    inspectorContent,
    inspectorDirty,
    inspectorError,
    loadInspectorFile,
    updateInspectorContent,
    saveInspector
  } = useAppStore();

  const projectFiles = editableFiles.filter((path) => !runFiles.includes(path));

  return (
    <aside className="panel flex h-full flex-col rounded-[30px] p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-[var(--color-ink-soft)]">
            Inspector
          </p>
          <h2 className="text-lg font-semibold tracking-[-0.04em]">Project files / run files</h2>
        </div>
        <button
          className="flex items-center gap-2 rounded-full bg-[rgba(15,139,141,0.12)] px-4 py-2 text-sm text-ocean"
          onClick={() => void saveInspector()}
          type="button"
        >
          <Save size={16} />
          {inspectorDirty ? "Save Changes" : "Saved"}
        </button>
      </div>

      <div className="mb-4">
        <div className="mb-2 text-xs uppercase tracking-[0.22em] text-[var(--color-ink-soft)]">
          Project
        </div>
        <div className="flex flex-wrap gap-2">
          {projectFiles.map((path) => (
            <button
              className={`rounded-full px-3 py-1 text-xs ${
                path === inspectorPath
                  ? "bg-[rgba(13,37,48,0.92)] text-white"
                  : "border border-[var(--color-line)] bg-white/55 text-[var(--color-ink-soft)]"
              }`}
              key={path}
              onClick={() => void loadInspectorFile(path)}
              type="button"
            >
              {path}
            </button>
          ))}
        </div>
      </div>

      {!!runFiles.length && (
        <div className="mb-4">
          <div className="mb-2 text-xs uppercase tracking-[0.22em] text-[var(--color-ink-soft)]">
            Run workspace
          </div>
          <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto pr-1">
            {runFiles.map((path) => (
              <button
                className={`rounded-full px-3 py-1 text-xs ${
                  path === inspectorPath
                    ? "bg-[rgba(15,139,141,0.88)] text-white"
                    : "border border-[var(--color-line)] bg-white/55 text-[var(--color-ink-soft)]"
                }`}
                key={path}
                onClick={() => void loadInspectorFile(path)}
                type="button"
              >
                {path}
              </button>
            ))}
          </div>
        </div>
      )}

      {inspectorError && (
        <div className="mb-4 rounded-[22px] border border-[rgba(212,106,74,0.26)] bg-[rgba(212,106,74,0.12)] px-4 py-3 text-sm text-[var(--color-ember)]">
          {inspectorError}
        </div>
      )}

      <div className="overflow-hidden rounded-[26px] border border-[var(--color-line)]">
        <Editor
          defaultLanguage="markdown"
          height="calc(100vh - 340px)"
          onChange={(value) => updateInspectorContent(value ?? "")}
          options={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: "on"
          }}
          path={inspectorPath}
          theme="vs-light"
          value={inspectorContent}
        />
      </div>
    </aside>
  );
}
