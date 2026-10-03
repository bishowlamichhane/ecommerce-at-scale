import React, { useState } from 'react'
import { IoSearch } from "react-icons/io5";
import axios from 'axios'
import { useNavigate } from 'react-router';
const Header = ({ setSearchItems, setSearchResponse, setSearchIds }) => {
  const [keyword, setKeyword] = useState();
  const navigate = useNavigate();
  const searchWord = async (value) => {
    setKeyword(value);
    console.log(value)
    if (!value.trim()) {
      setSearchItems([]);
      return;
    }
    try {
      const startTime = performance.now();

      const { data } = await axios.get(`http://localhost:5000/search/search-products?q=${value}`)
      const endTime = performance.now();
      setSearchResponse((endTime - startTime).toFixed(2));

      setSearchIds(data.message.map(p => p.id));

      setSearchItems(data.message);
      console.log(data.message)
    } catch (error) {
      console.error("Search failed:", error.message);

    }
  }



  return (
    <div className='w-full h-16 shadow-md px-10 flex justify-around items-center'>
      <div className='w-1/3 border-r border-gray-300'>
        <p className='text-2xl cursor-pointer' onClick={() => navigate('/')}
        >ECommerce</p>
      </div>
      <div className='w-2/3 flex justify-center items-center'>
        <input
          type='text'
          placeholder='Search'
          onChange={(e) => searchWord(e.target.value)}
          className='w-4/5 px-3 h-10 py-2 border border-gray-300 rounded-md outline-none'
        />
        <IoSearch size={24} className='ml-2' />
      </div>

      <div> <button className='cursor-pointer' onClick={() => navigate('/cart')}>Cart</button></div>
    </div>

  )
}

export default Header