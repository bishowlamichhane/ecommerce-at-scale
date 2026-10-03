-- Release a lock only if we still hold it: compare the token, then delete,
-- in one step. Without the check, a holder that overran its lock's expiry
-- would delete the lock of whoever took over from it.
--
-- KEYS[1]  the lock key
-- ARGV[1]  our token
-- Returns 1 if we released it, 0 if it wasn't ours (any more).

if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
