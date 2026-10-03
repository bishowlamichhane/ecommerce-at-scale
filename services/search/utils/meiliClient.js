import { MeiliSearch } from "meilisearch";

const client = new MeiliSearch({
  host: "http://localhost:7700", 
  // masterKey:// optional for development
});




export default client;
