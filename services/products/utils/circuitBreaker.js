import CircuitBreaker from "opossum";
import axios from "axios";


const http = axios.create({
  timeout: 3000, 
});

const axiosRequest = async (url, options = {}) => {
  const res = await http({ url, ...options });
  return res.data;
};


const breakerOptions = {
  timeout: 5000, // If request takes >5s → fail
  errorThresholdPercentage: 50, // Open if 50% of requests fail
  resetTimeout: 10000, // After 10s, try again (half-open)
};

const breaker = new CircuitBreaker(axiosRequest, breakerOptions);

breaker.on("open", () => console.warn("⚠️ Circuit breaker OPEN - external service failing"));
breaker.on("halfOpen", () => console.log("🕐 Circuit breaker HALF-OPEN - testing service"));
breaker.on("close", () => console.log("✅ Circuit breaker CLOSED - service healthy again"));
breaker.on("timeout", () => console.warn("⏳ Circuit breaker TIMEOUT"));
breaker.on("reject", () => console.warn("🚫 Request rejected by OPEN breaker"));

export default breaker;
