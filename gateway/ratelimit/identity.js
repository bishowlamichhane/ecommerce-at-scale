import net from "node:net";

// Who is asking: the shopper id the client claims, and where it connects from.

// Ids look like "shopper-<uuid>", "user-42" or "bot-3". The length cap keeps
// Redis keys and database rows small. The character set keeps out spaces and
// commas: two X-User-Id headers arrive joined as "a, b", and that's refused.
const USER_ID = /^[A-Za-z0-9._:@-]{1,64}$/;

export const isValidUserId = (id) => USER_ID.test(id);

// X-User-Id is optional. Without it a request is limited by IP only:
// sharing one "guest" bucket would let a single abuser lock out every guest.
export function identifyShopper(req, res, next) {
  const id = req.get("X-User-Id");
  if (id === undefined) return next();
  if (!isValidUserId(id)) {
    return res.status(400).json({
      message: "X-User-Id must be 1-64 letters, digits or . _ : @ -",
      success: false,
    });
  }
  req.shopperId = id;
  next();
}

// The rate-limit key for a client address:
//   IPv4, also when written as IPv6 (::ffff:1.2.3.4): the address itself.
//   IPv6: its /64 network. A home or a server usually gets a whole /64, so
//   limiting single IPv6 addresses would hand an abuser 2^64 fresh identities.
export function ipKey(address) {
  if (!address) return "unknown";
  let ip = address;
  const zone = ip.indexOf("%"); // a zone id, as in fe80::1%eth0
  if (zone !== -1) ip = ip.slice(0, zone);

  if (ip.toLowerCase().startsWith("::ffff:") && net.isIPv4(ip.slice(7))) return ip.slice(7);
  if (net.isIPv4(ip)) return ip;
  if (net.isIPv6(ip)) return `${expandIPv6(ip).slice(0, 4).join(":")}::/64`;
  return "unknown";
}

// "2001:db8::1" → ["2001", "db8", "0", "0", "0", "0", "0", "1"]
// Expects a valid address (checked with net.isIPv6 first).
function expandIPv6(ip) {
  const [head, tail] = ip.split("::");
  const groups = (part) => (part ? part.split(":").flatMap(ipv4AsGroups) : []);
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const zeros = tail === undefined ? [] : new Array(8 - front.length - back.length).fill("0");
  return [...front, ...zeros, ...back].map((group) => parseInt(group, 16).toString(16));
}

// The last group can be an IPv4 address (64:ff9b::192.0.2.1): two groups of 16 bits.
function ipv4AsGroups(group) {
  if (!group.includes(".")) return [group];
  const [a, b, c, d] = group.split(".").map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}
