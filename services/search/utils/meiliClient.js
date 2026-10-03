import { Meilisearch } from "meilisearch";

const client = new Meilisearch({
  host: "http://localhost:7700", 
  // masterKey:// optional for development
});




export default client;
