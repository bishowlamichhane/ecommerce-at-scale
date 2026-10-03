-- Fixed-window counter: the common approach, kept as the baseline that GCRA
-- is measured against. Its known flaw: a client can use a whole window's
-- limit just before the window ends and another just after it starts, so
-- twice the limit gets through in a few milliseconds.
--
-- Each key is a hash {w = window number, c = requests counted in it}. The
-- window lives in the value, not the key name, so every key the script
-- touches is declared in KEYS.
--
-- KEYS[i]               one key per limit
-- ARGV[1]               now in milliseconds, or '' to use the Redis clock
-- ARGV[2i], ARGV[2i+1]  window_ms and limit for KEYS[i]
--
-- Returns the same shape as gcra.lua:
-- {allowed (1/0), then for each key: remaining, retry_after_ms, reset_after_ms}

local now
if ARGV[1] == '' then
  local time = redis.call('TIME')
  now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
else
  now = tonumber(ARGV[1])
end

local allowed = 1
local windows = {}
local counts = {}

for i = 1, #KEYS do
  local window_ms = tonumber(ARGV[2 * i])
  local limit = tonumber(ARGV[2 * i + 1])
  local current = math.floor(now / window_ms)
  local stored = redis.call('HMGET', KEYS[i], 'w', 'c')
  local count = 0
  if tonumber(stored[1]) == current then count = tonumber(stored[2]) end
  windows[i] = current
  counts[i] = count
  if count >= limit then allowed = 0 end
end

local reply = { allowed }
for i = 1, #KEYS do
  local window_ms = tonumber(ARGV[2 * i])
  local limit = tonumber(ARGV[2 * i + 1])
  local count = counts[i]
  local window_end = (windows[i] + 1) * window_ms
  if allowed == 1 then
    count = count + 1
    redis.call('HSET', KEYS[i], 'w', string.format('%d', windows[i]), 'c', count)
    redis.call('PEXPIRE', KEYS[i], string.format('%d', window_end - now))
  end

  local remaining = limit - count
  local retry_after = 0
  if remaining <= 0 then
    remaining = 0
    retry_after = window_end - now
  end

  reply[#reply + 1] = remaining
  reply[#reply + 1] = retry_after
  reply[#reply + 1] = window_end - now
end
return reply
