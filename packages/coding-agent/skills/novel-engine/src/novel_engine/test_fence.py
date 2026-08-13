#!/usr/bin/env python3
import json
import re

test_content = '''


```json
{"hello": "world"}
```
'''

cleaned = test_content.strip()
print(f'Stripped starts with backticks: {cleaned.startswith("```")}')
if cleaned.startswith('```'):
    cleaned = re.sub(r'^```(?:json)?\s*', '', cleaned)
    cleaned = re.sub(r'\s*```$', '', cleaned)
    print(f'After cleanup: {repr(cleaned)}')
    result = json.loads(cleaned)
    print(f'Parsed: {result}')
else:
    print('No fence detected, parsing directly')
    result = json.loads(cleaned)
    print(f'Parsed: {result}')
