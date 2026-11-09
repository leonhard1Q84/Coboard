"""Rebuild annotated CC BY-SA 4.0 data using only the Python standard library.
Usage: python3 build-english-lexicon.py PINNED_SMALL_EN_GZ OUTPUT_TXT
Upstream: rspeer/wordfreq commit 912caf64b657478d1dff1138efdc078947d54bb1.
This script downloads nothing. It verifies the exact upstream compressed bytes.
"""
import gzip
import hashlib
import json
import sys
from pathlib import Path

raw = Path(sys.argv[1]).read_bytes()
if hashlib.sha256(raw).hexdigest() != 'f94a80cba6a3857b260d0666b5432bb7ea9b85315574dee9c306e87f61298247':
    raise ValueError('unexpected source SHA-256')
data = gzip.decompress(raw)
pos = 0


def take(n):
    global pos
    if n < 0 or pos + n > len(data):
        raise ValueError('truncated MessagePack')
    value = data[pos:pos+n]
    pos += n
    return value


def read(depth=0):
    if depth > 10:
        raise ValueError('nested MessagePack')
    tag = take(1)[0]
    if tag < 128:
        return tag
    if tag & 0xe0 == 0xa0:
        return take(tag & 31).decode()
    if tag in (0xd9, 0xda):
        return take(int.from_bytes(take(1 if tag == 0xd9 else 2), 'big')).decode()
    if tag & 0xf0 == 0x90 or tag == 0xdc:
        n = tag & 15 if tag != 0xdc else int.from_bytes(take(2), 'big')
        return [read(depth+1) for _ in range(n)]
    if tag & 0xf0 == 0x80:
        return {read(depth+1): read(depth+1) for _ in range(tag & 15)}
    raise ValueError(f'unsupported MessagePack tag {tag:#x}')


bins = read()
if pos != len(data):
    raise ValueError('trailing MessagePack')
words = {word: 9 - index / 100 for index, group in enumerate(bins[1:])
         for word in group if word.isascii() and word.isalpha() and word.islower() and 2 <= len(word) <= 20}
notice = (Path(__file__).parents[2] / 'crates/coboard-vision-ml/data/wordfreq-NOTICE.md').read_text()
header = '''# Coboard English lexicon, derived from wordfreq 3.2 by Robyn Speer.
# Data license: Creative Commons Attribution-ShareAlike 4.0 International.
# https://creativecommons.org/licenses/by-sa/4.0/
# Source: https://github.com/rspeer/wordfreq/tree/912caf64b657478d1dff1138efdc078947d54bb1
# Source file: wordfreq/data/small_en.msgpack.gz
# Changes: retain lowercase ASCII words of 2..20 bytes; sorted spelling and Zipf bins.
# This annotated data file, including its attribution, is embedded in the Rust engine.
# Derived data remains CC BY-SA 4.0. The license does not relicense Coboard code.
# Upstream attribution and source notices follow (also in wordfreq-NOTICE.md).
'''
header += ''.join('# ' + line + '\n' for line in notice.splitlines())
result = header + '# word\tZipf_frequency\n' + ''.join(f'{word}\t{words[word]:.2f}\n' for word in sorted(words))
Path(sys.argv[2]).write_text(result)
print(json.dumps({'words': len(words), 'bytes': len(result.encode()), 'sha256': hashlib.sha256(result.encode()).hexdigest()}))
