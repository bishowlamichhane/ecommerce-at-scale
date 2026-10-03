-- Reserve every item of an order, or nothing.
--
-- KEYS[1]     resv:<reservationId>  hash: stock key -> quantity taken, plus 'state'
-- KEYS[2]     resv:pending          sorted set of open reservations, scored by time
-- KEYS[3..n]  stock:<productId>     one per item (a number, or 'untracked')
-- ARGV[1]     reservation id
-- ARGV[2]     now, in milliseconds
-- ARGV[3..n]  quantity for the matching stock key
--
-- Returns 0 when everything was reserved, otherwise the position (1-based)
-- of the first item without enough stock. Redis runs a script start to
-- finish without running any other command in between, which is what makes
-- check-then-decrement safe here.

local items = #KEYS - 2

for i = 1, items do
  local stock = redis.call('GET', KEYS[i + 2])
  if not stock then
    return redis.error_reply('stock not loaded: ' .. KEYS[i + 2])
  end
  if stock ~= 'untracked' and tonumber(stock) < tonumber(ARGV[i + 2]) then
    return i
  end
end

for i = 1, items do
  if redis.call('GET', KEYS[i + 2]) ~= 'untracked' then
    redis.call('DECRBY', KEYS[i + 2], ARGV[i + 2])
  end
  redis.call('HSET', KEYS[1], KEYS[i + 2], ARGV[i + 2])
end
-- 'reserved' until an order claims it (claim.lua sets 'committing')
redis.call('HSET', KEYS[1], 'state', 'reserved')
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 0
