"""Fast encoding of already validated scientific response dictionaries."""

import orjson
from starlette.responses import JSONResponse


class ScientificJSONResponse(JSONResponse):
    def render(self, content):
        return orjson.dumps(content)
