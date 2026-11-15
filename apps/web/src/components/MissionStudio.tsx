import { useEffect, useRef, useState } from "react";
import type { SearchRequest } from "../lib/types";
import { downloadJson, utcDate } from "../lib/format";
import {
  MISSION_PRESETS,
  isMissionRequest,
  readSavedMissions,
  writeSavedMissions,
} from "../lib/missions";
import type { SavedMission } from "../lib/missions";
import { validateSearch } from "../lib/api";
import { Icon } from "./Icon";

export function MissionLibrary({
  value,
  scienceAvailable,
  onLoad,
  onClose,
}: {
  value: SearchRequest;
  scienceAvailable: boolean;
  onLoad: (request: SearchRequest) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    file = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<SavedMission[]>(readSavedMissions),
    [name, setName] = useState("My polar mission"),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    const current = dialog.current;
    current?.showModal();
    return () => current?.close();
  }, []);
  async function load(request: SearchRequest) {
    setLoading(true);
    setError(null);
    try {
      await validateSearch(request);
      onLoad(structuredClone(request));
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The mission configuration could not be validated.",
      );
    } finally {
      setLoading(false);
    }
  }
  async function importFile(selected: File | undefined) {
    if (!selected) return;
    setError(null);
    if (selected.size > 25 * 1024 * 1024) {
      setError("Choose a configuration or analysis report under 25 MB.");
      return;
    }
    try {
      const payload = JSON.parse(await selected.text());
      const request = payload?.request ?? payload;
      if (!isMissionRequest(request))
        throw new Error(
          "This file does not contain a mission request. Import a Lumen configuration or analysis report.",
        );
      await load(request);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not read this JSON file.",
      );
    }
    if (file.current) file.current.value = "";
  }
  function persist(next: SavedMission[]) {
    try {
      writeSavedMissions(next);
      setSaved(next);
      return true;
    } catch {
      setError(
        "Browser storage is unavailable or full. Export the mission as JSON to keep a copy.",
      );
      return false;
    }
  }
  return (
    <dialog
      ref={dialog}
      className="methods-dialog mission-library"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="library-title"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">MISSION LIBRARY</span>
          <h2 id="library-title">A starting point for the next question.</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close mission library"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <p className="small muted">
        Presets are representative studies, not official mission parameters.
        Loading one updates the form; it never starts a search automatically.
      </p>
      <div className="preset-grid">
        {MISSION_PRESETS.map((preset) => (
          <article key={preset.id}>
            <Icon
              name={
                preset.id === "solar"
                  ? "sun"
                  : preset.id === "contact"
                    ? "earth"
                    : "compass"
              }
            />
            <h3>{preset.name}</h3>
            <p>{preset.description}</p>
            <button
              className="text-button"
              disabled={
                loading || (preset.id === "science" && !scienceAvailable)
              }
              onClick={() => void load(preset.request)}
            >
              Load preset
              <Icon name="arrow" size={14} />
            </button>
          </article>
        ))}
      </div>
      <div className="section-heading">
        <h3>Saved in this browser</h3>
        <span className="small muted">{saved.length}/12</span>
      </div>
      <p className="field-hint">
        Only mission inputs are stored. No account, cloud sync, or saved
        scientific results.
      </p>
      <div className="save-mission-row">
        <label className="field">
          Mission name
          <input
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button
          className="secondary-button"
          disabled={!name.trim() || saved.length >= 12}
          onClick={() => {
            if (
              persist([
                {
                  id: crypto.randomUUID(),
                  name: name.trim(),
                  saved_utc: new Date().toISOString(),
                  request: structuredClone(value),
                },
                ...saved,
              ])
            )
              setNotice("Current mission inputs saved in this browser.");
          }}
        >
          <Icon name="pin" size={15} />
          Save current inputs
        </button>
      </div>
      {!saved.length ? (
        <p className="small muted">No saved missions yet.</p>
      ) : (
        <div className="saved-missions">
          {saved.map((mission) => (
            <article key={mission.id}>
              <div>
                <strong>{mission.name}</strong>
                <span>
                  {utcDate(mission.request.time_range.start_utc)} →{" "}
                  {utcDate(mission.request.time_range.end_utc)} · UTC
                </span>
              </div>
              <button
                className="text-button"
                disabled={loading}
                onClick={() => void load(mission.request)}
              >
                Load
              </button>
              <button
                className="icon-button"
                aria-label={`Export ${mission.name}`}
                onClick={() =>
                  downloadJson(
                    { name: mission.name, request: mission.request },
                    `lumen-mission-${mission.id}.json`,
                  )
                }
              >
                <Icon name="download" size={15} />
              </button>
              <button
                className="icon-button"
                aria-label={`Delete ${mission.name}`}
                onClick={() =>
                  persist(saved.filter((item) => item.id !== mission.id))
                }
              >
                <Icon name="close" size={15} />
              </button>
            </article>
          ))}
        </div>
      )}
      {notice && (
        <p className="success-note" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions">
        <button
          className="secondary-button"
          onClick={() =>
            downloadJson(
              { schema_version: "lumen-mission-1", request: value },
              "lumen-mission.json",
            )
          }
        >
          <Icon name="download" size={15} />
          Export current configuration
        </button>
        <button
          className="secondary-button"
          disabled={loading}
          onClick={() => file.current?.click()}
        >
          Import configuration or report
        </button>
        <input
          type="file"
          accept=".json,application/json"
          className="sr-only"
          tabIndex={-1}
          ref={file}
          onChange={(e) => void importFile(e.target.files?.[0])}
        />
      </div>
    </dialog>
  );
}
