import re, json

path = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'
with open(path, encoding='utf-8') as f:
    content = f.read()

LQ = '“'  # "
RQ = '”'  # "

# Fix 1: curly quotes wrapping JSON keys  (before a colon)
fixed = re.sub(
    '[' + LQ + RQ + ']([a-zA-Z_][a-zA-Z0-9_]*)' + '[' + LQ + RQ + '](\\s*:)',
    lambda m: '"' + m.group(1) + '"' + m.group(2),
    content
)

# Fix 2: curly quotes used as JSON string-value delimiters
# Pattern: colon + optional space + LQ ... RQ (where the RQ is immediately followed by comma/newline/})
# We do this by replacing LQ that appears right after ': ' with '"',
# and RQ that is followed by \n or , with '"'
# More precise: replace ': "' -> ': "' and the matching closing '"' -> '"'
# Use a state machine approach: scan for ': "' patterns

lines = fixed.split('\n')
result_lines = []
for line in lines:
    # If line contains ': "' where " is LQ (U+201C), replace with ': "'
    # and the closing " (U+201D) at end of value with '"'
    if LQ in line:
        # Check if it follows a colon (value delimiter position)
        line = re.sub(r'(:\s*)' + LQ, r'\1"', line)
    if RQ in line:
        # Replace RQ that ends a JSON string value (before comma, newline, or closing bracket)
        line = re.sub(RQ + r'(\s*[,\}\]]|\s*$)', r'"\1', line)
    result_lines.append(line)

fixed = '\n'.join(result_lines)

# Verify
remaining_lq = fixed.count(LQ)
remaining_rq = fixed.count(RQ)
print(f'Remaining LQ: {remaining_lq}, RQ: {remaining_rq}')

try:
    json.loads(fixed)
    print('JSON valid!')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(fixed)
    print('Saved.')
except json.JSONDecodeError as e:
    print(f'Still invalid: {e}')
    pos = e.pos
    ctx = fixed[pos-60:pos+60]
    print(f'Context around error: {repr(ctx)}')
    print(f'Chars: {[hex(ord(c)) for c in fixed[pos-3:pos+8]]}')
