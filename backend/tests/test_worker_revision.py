import json

from app.services.worker_pool import source_revision


def test_source_revision_tracks_artifact_changes(tmp_path):
    root, kernels = tmp_path / "data", tmp_path / "kernels"
    root.mkdir()
    kernels.mkdir()
    (root / "metadata.json").write_text(json.dumps({"artifacts": {"terrain.npz": {}}}))
    (root / "terrain.npz").write_bytes(b"original")
    (kernels / "manifest.json").write_text(json.dumps([{"file": "kernel.bsp"}]))
    (kernels / "kernel.bsp").write_bytes(b"kernel")
    environment = {"LUMEN_DATA_ROOT": str(root), "LUMEN_KERNEL_ROOT": str(kernels)}
    first = source_revision(environment)
    assert source_revision(environment) == first
    (root / "terrain.npz").write_bytes(b"changed data")
    second = source_revision(environment)
    assert second != first
    (kernels / "kernel.bsp").write_bytes(b"changed kernel")
    assert source_revision(environment) != second


def test_source_revision_includes_kernel_mode(tmp_path):
    environment = {"LUMEN_DATA_ROOT": str(tmp_path), "LUMEN_KERNEL_ROOT": str(tmp_path)}
    assert source_revision(environment) != source_revision(
        {**environment, "LUMEN_TEMPORAL_KERNEL": "compiled"}
    )


def test_revision_tracks_global_survey_and_scientific_code(tmp_path, monkeypatch):
    from app.services import worker_pool
    code = tmp_path / "backend/app/services/worker_pool.py"
    code.parent.mkdir(parents=True)
    code.write_text("algorithm = 1", encoding="utf-8")
    monkeypatch.setattr(worker_pool, "__file__", str(code))
    hemisphere = tmp_path / "terrain"
    (hemisphere / "survey").mkdir(parents=True)
    global_root = tmp_path / "global"
    global_root.mkdir()
    environment = {"LUMEN_DATA_ROOT": str(tmp_path / "data"),
                   "LUMEN_KERNEL_ROOT": str(tmp_path / "kernels"),
                   "LUMEN_HEMISPHERE_ROOT": str(hemisphere), "LUMEN_GLOBAL_ROOT": str(global_root)}
    previous = source_revision(environment)
    for path in (hemisphere / "survey/manifest.json", hemisphere / "survey/terrain.npz",
                 global_root / "metadata.json", global_root / "elevation.npz", code):
        path.write_text("changed", encoding="utf-8")
        current = source_revision(environment)
        assert current != previous
        previous = current
