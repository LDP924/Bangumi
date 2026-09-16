#!/usr/bin/env python3
"""上游提交按 1h 聚簇, 取最新一次 push 会话的提交, 输出发行版日志.

用法: cluster-notes.py <git-log-range>
输入: git log <range> --no-merges --pretty=format:'%ci|%H|%s' 的输出
"""
import sys
import re
from datetime import datetime

rows = []
for line in sys.stdin:
    parts = line.split('|', 2)
    if len(parts) == 3:
        try:
            t = datetime.strptime(parts[0][:19], '%Y-%m-%d %H:%M:%S')
        except ValueError:
            continue
        rows.append((t, parts[1].strip(), parts[2]))

if not rows:
    sys.exit(0)

# git log 倒序输出 → 转正序(旧→新)
rows.reverse()

# 从最新提交向前聚簇: 间隔 >1h 断开, 取最新一簇
cluster = [rows[-1]]
for row in reversed(rows[:-1]):
    if (cluster[0][0] - row[0]).total_seconds() > 3600:
        break
    cluster.insert(0, row)

for t, h, s in cluster:
    s = ' '.join(s.split())  # 压平跨行 subject
    s = re.sub(r'(?<![A-Za-z0-9])#(\d+)', r'czy0729#\1', s)  # issue 指向上游
    print(f'{s} ([{h[:7]}](https://github.com/czy0729/Bangumi/commit/{h}))')
