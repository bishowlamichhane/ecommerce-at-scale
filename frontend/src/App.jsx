import { useState } from "react";
import { Outlet } from "react-router";
import Header from "./components/Header";

const App = () => {
  const [searchIds, setSearchIds] = useState([])
  const [searchItems, setSearchItems] = useState([]);
  const [searchResponse, setSearchResponse] = useState()
  return (
    <div className="flex flex-col h-full w-100vw">
      <Header setSearchItems={setSearchItems} setSearchResponse={setSearchResponse} setSearchIds={setSearchIds} />
      <Outlet context={{ searchIds, searchItems, searchResponse }} />
    </div>

  );
};

export default App;
