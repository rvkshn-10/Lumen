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


def test_digest_invalidates_when_write_timestamp_is_preserved(tmp_path):
    import os

    from app.services.terrain_store import digest
    path = tmp_path / "terrain.img"
    path.write_bytes(b"original")
    stat = path.stat()
    first = digest(path)
    path.write_bytes(b"modified")
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert digest(path) != first


def test_small_artifact_stamp_uses_content_when_metadata_clock_collides(tmp_path, monkeypatch):
    import os

    from app.services import terrain_store
    path = tmp_path / "terrain.img"
    path.write_bytes(b"original")
    stat = path.stat()
    # Simulate coarse filesystem change-time metadata, independently of the OS clock.
    if os.name == "nt":
        library, info_type = terrain_store._windows_file_api()
        original = library.GetFileInformationByHandleEx
        def fixed_change(handle, kind, pointer, size):
            import ctypes
            result = original(handle, kind, pointer, size)
            ctypes.cast(pointer, ctypes.POINTER(info_type)).contents.changed = 123
            return result
        monkeypatch.setattr(library, "GetFileInformationByHandleEx", fixed_change)
    first = terrain_store.digest(path)
    path.write_bytes(b"modified")
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert terrain_store.digest(path) != first


def test_worker_revision_changes_with_scientific_software_versions(tmp_path, monkeypatch):
    from app.services import result_cache
    environment = {"LUMEN_DATA_ROOT": str(tmp_path), "LUMEN_KERNEL_ROOT": str(tmp_path),
                   "LUMEN_HEMISPHERE_ROOT": str(tmp_path), "LUMEN_GLOBAL_ROOT": str(tmp_path)}
    monkeypatch.setattr(result_cache, "software_revision", lambda: ("runtime-v1",))
    previous = source_revision(environment)
    monkeypatch.setattr(result_cache, "software_revision", lambda: ("runtime-v2",))
    assert source_revision(environment) != previous
