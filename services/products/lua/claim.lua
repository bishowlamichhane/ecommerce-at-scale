-- Claim a reservation for its order: mark it 'committing' and return what it
-- holds. From then on release.lua refuses it, so the stock can't be handed
-- back between this moment and the Postgres write that makes it final.
-- Claiming a 'committing' reservation again is fine: that's a commit job
-- being retried after a crash.
--
-- KEYS[1]  resv:<reservationId>
--
-- Returns {stockKey, quantity, stockKey, quantity, ...}, or an empty list if
-- the reservation is gone (already committed, or released).

if redis.call('EXISTS', KEYS[1]) == 0 then return {} end
redis.call('HSET', KEYS[1], 'state', 'committing')

local taken = redis.call('HGETALL', KEYS[1])
local items = {}
for i = 1, #taken, 2 do
  if taken[i] ~= 'state' then
    items[#items + 1] = taken[i]
    items[#items + 1] = taken[i + 1]
  end
end
return items
