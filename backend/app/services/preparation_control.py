"""Cooperative checkpoints used only by speculative worker operations."""

from contextlib import contextmanager
from threading import Event

cancel = Event()
_preparing = False


class PreparationCanceled(Exception):
    pass


def checkpoint():
    if _preparing and cancel.is_set():
        raise PreparationCanceled()


@contextmanager
def speculative():
    global _preparing
    _preparing = True
    try:
        checkpoint()
        yield
    finally:
        _preparing = False

