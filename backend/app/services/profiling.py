"""Optional ITT tasks and request-local wall times; never change scientific output."""

from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
from time import perf_counter

try:
    import ittapi
except (ImportError, OSError):
    ittapi = None

_timings = ContextVar("search_phase_timings", default=None)


@contextmanager
def collect_phases():
    values = {}
    token = _timings.set(values)
    try:
        yield values
    finally:
        _timings.reset(token)


@contextmanager
def phase(name):
    started = perf_counter()
    with ittapi.task(name, domain="lumen.search") if ittapi else nullcontext():
        try:
            yield
        finally:
            values = _timings.get()
            if values is not None:
                values[name] = values.get(name, 0.0) + perf_counter() - started
