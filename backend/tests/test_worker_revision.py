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
