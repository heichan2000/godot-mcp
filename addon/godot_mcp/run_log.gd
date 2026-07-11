@tool
extends RefCounted

## Bounded, cursor-addressable log of the current (or last) play session's
## output (REQ-E-03). Entries carry a monotonically increasing seq that
## survives reset(), so a cursor taken before a new session stays valid and
## simply resumes at the new session's lines. dropped_lines tells a reader
## how many lines the ring evicted before it could read them - the
## boundedness signal under log spam.

const DEFAULT_CAPACITY := 1000
const MAX_LINES_PER_READ := 500
const MAX_LINE_CHARS := 4096

var _capacity := DEFAULT_CAPACITY
var _entries: Array[Dictionary] = []
var _next_seq := 1
## Seq of the last entry discarded by reset(); reads clamp cursors up to it
## so dropped_lines never counts lines from before the current session.
var _session_floor := 0


func push(stream: String, text: String) -> void:
	_entries.push_back({"seq": _next_seq, "stream": stream, "text": text.left(MAX_LINE_CHARS)})
	_next_seq += 1
	while _entries.size() > _capacity:
		_entries.pop_front()


## Lines with seq > after (oldest first), capped at MAX_LINES_PER_READ per
## call - callers page by passing next_cursor back until lines is empty.
func read_after(after: int) -> Dictionary:
	var effective_after := maxi(after, _session_floor)
	var first_available := _next_seq
	if not _entries.is_empty():
		first_available = int(_entries[0]["seq"])
	var lines: Array = []
	var cursor := effective_after
	for entry in _entries:
		if int(entry["seq"]) <= effective_after:
			continue
		if lines.size() >= MAX_LINES_PER_READ:
			break
		lines.append({"stream": entry["stream"], "text": entry["text"]})
		cursor = int(entry["seq"])
	return {
		"lines": lines,
		"next_cursor": cursor,
		"dropped_lines": maxi(0, first_available - 1 - effective_after),
	}


## New session: drop retained output and re-arm capacity (0 keeps current).
func reset(capacity: int) -> void:
	_entries.clear()
	_session_floor = _next_seq - 1
	if capacity > 0:
		_capacity = capacity
