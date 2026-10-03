import React, { useEffect, useState } from "react";
import Header from "./components/Header";
import Categories from "./components/Categories";
import Hero from "./components/Hero";
import axios from "axios";

import { useOutletContext } from "react-router-dom";

const Home = () => {
    const { searchIds, searchItems, searchResponse } = useOutletContext();
    const [items, setItems] = useState([]);
    const [responseTime, setResponseTime] = useState();

    const [loading, setLoading] = useState(false);
    const limit = 20;
    const [skip, setSkip] = useState(0)

    const [filteredItems, setFilteredItems] = useState([]);
    const [filteredTime, setFilteredTime] = useState([]);
    console.log(searchIds)
    // ✅ Fetch items
    const fetchItems = async () => {
        try {
            setLoading(true);
            console.log(skip)
            const startTime = performance.now();

            const { data } = await axios.get(
                `http://localhost:5000/products/get-products?limit=${limit}&skip=${skip}`
            );
            const endTime = performance.now();
            setResponseTime((endTime - startTime).toFixed(2));


            setItems((prevItems) => [...prevItems, ...data.message]);

        } catch (err) {
            console.error(" Failed to fetch items:", err.message);
        } finally {
            setLoading(false);
        }
    };

    const onLoadMore = () => {
        setSkip(prev => prev + limit)

        
    }

    // ✅ Initial fetch
    useEffect(() => {
        fetchItems();
    }, [skip]);


    return (

        <main className="w-full h-[calc(100%-16px)] flex gap-4">
            <Categories setFilteredItems={setFilteredItems} setFilteredTime={setFilteredTime} searchIds={searchIds} />
            <Hero
                onLoadMore={onLoadMore}
                items={
                    // 1️ If we have filtered items from search + filter, show them
                    filteredItems.length > 0
                        ? filteredItems
                        : // 2️ Else if we have search results but no filter, show searchItems
                        searchItems.length > 0
                            ? searchItems
                            : // 3️ Else show fetched items
                            items
                }
                duration={filteredItems.length > 0
                    ? filteredTime
                    : // 2️ Else if we have search results but no filter, show searchItems
                    searchItems.length > 0
                        ? searchResponse
                        : // 3️ Else show fetched items
                        responseTime}

                loading={loading}
            />
        </main>

    )
}

export default Home