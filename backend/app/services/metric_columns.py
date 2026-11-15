"""Read-only temporal columns with lazy, ordinary Python row dictionaries."""

from collections.abc import Sequence


class MetricRows(Sequence):
    def __init__(self, columns):
        self.columns = columns
        for values in columns.values():
            values.flags.writeable = False

    def __len__(self):
        return len(next(iter(self.columns.values())))

    def __getitem__(self, index):
        if isinstance(index, slice):
            return tuple(self[i] for i in range(*index.indices(len(self))))
        return {key: float(values[index]) for key, values in self.columns.items()}
