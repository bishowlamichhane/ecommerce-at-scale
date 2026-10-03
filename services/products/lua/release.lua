-- Give back the stock of a reservation that won't become an order.
--
-- KEYS[1]  resv:<reservationId>
-- KEYS[2]  resv:pending
-- ARGV[1]  reservation id
--
-- Returns how many items were released, or 0 if the reservation no longer
-- exists, so releasing twice is harmless. The stock keys are read from the
-- hash instead of being passed in KEYS: fine on a single Redis server, but a
-- Redis Cluster would reject it.

local taken = redis.call('HGETALL', KEYS[1])
for i = 1, #taken, 2 do
  if redis.call('GET', taken[i]) ~= 'untracked' then
    redis.call('INCRBY', taken[i], taken[i + 1])
  end
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return #taken / 2
