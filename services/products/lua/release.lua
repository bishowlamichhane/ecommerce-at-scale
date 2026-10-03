-- Give back the stock of a reservation that won't become an order.
--
-- KEYS[1]  resv:<reservationId>   hash: stock key -> quantity, plus 'state'
-- KEYS[2]  resv:pending
-- ARGV[1]  reservation id
--
-- Returns how many items were released; 0 if the reservation no longer
-- exists, so releasing twice is harmless; or -1 if it is being committed.
-- An order exists for a committing reservation, so its stock must never come
-- back, whoever asks (a late retry, or the sweeper).
--
-- The stock keys are read from the hash instead of being passed in KEYS:
-- fine on a single Redis server, but a Redis Cluster would reject it.

if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], 'state') == 'committing' then return -1 end

local taken = redis.call('HGETALL', KEYS[1])
local released = 0
for i = 1, #taken, 2 do
  if taken[i] ~= 'state' then
    if redis.call('GET', taken[i]) ~= 'untracked' then
      redis.call('INCRBY', taken[i], taken[i + 1])
    end
    released = released + 1
  end
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return released
