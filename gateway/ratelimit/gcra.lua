-- GCRA (Generic Cell Rate Algorithm), checked for several limits at once.
-- The request is allowed only if every limit allows it, and only then is
-- anything written: all or nothing, like reserve.lua in the products service.
--
-- Each key holds one number, the "theoretical arrival time" (TAT): the moment
-- the bucket would be completely full again if no more requests came. Every
-- allowed request pushes the TAT one `interval` further into the future, and
-- a request is allowed while the TAT stays within `burst` intervals of now.
-- One number per client, and keys expire by themselves once they're full
-- again, so idle clients cost no memory.
--
-- KEYS[i]               one key per limit
-- ARGV[1]               now in milliseconds, or '' to use the Redis clock.
--                       The gateway passes '', so every gateway instance reads
--                       the same clock; tests pass fixed times.
-- ARGV[2i], ARGV[2i+1]  interval_ms and burst for KEYS[i]; interval_ms is a
--                       whole number of milliseconds, at least 1
--
-- Returns {allowed (1/0), then for each key: remaining, retry_after_ms, reset_after_ms}
--   remaining       requests this key would still allow right now
--   retry_after_ms  wait before this key allows the next request (0 = now)
--   reset_after_ms  wait until this key's bucket is completely full again

local now
if ARGV[1] == '' then
  local time = redis.call('TIME')
  now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
else
  now = tonumber(ARGV[1])
end

local allowed = 1
local tats = {}

for i = 1, #KEYS do
  local interval = tonumber(ARGV[2 * i])
  local burst = tonumber(ARGV[2 * i + 1])
  local tat = tonumber(redis.call('GET', KEYS[i]))
  if not tat or tat < now then tat = now end
  tats[i] = tat
  -- Taking this request would push the TAT one interval further. It must
  -- stay within `burst` intervals of now.
  if tat + interval - now > burst * interval then
    allowed = 0
  end
end

local reply = { allowed }
for i = 1, #KEYS do
  local interval = tonumber(ARGV[2 * i])
  local burst = tonumber(ARGV[2 * i + 1])
  local tat = tats[i]
  if allowed == 1 then
    tat = tat + interval
    -- string.format keeps 13-digit millisecond values out of scientific notation.
    redis.call('SET', KEYS[i], string.format('%d', tat), 'PX', string.format('%d', tat - now))
  end

  local remaining = math.floor((burst * interval - (tat - now)) / interval)
  if remaining < 0 then remaining = 0 end
  local retry_after = tat + interval - burst * interval - now
  if retry_after < 0 then retry_after = 0 end

  reply[#reply + 1] = remaining
  reply[#reply + 1] = retry_after
  reply[#reply + 1] = tat - now
end
return reply
