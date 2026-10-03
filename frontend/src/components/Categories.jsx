import React, { useState } from 'react';
import axios from 'axios';

const Categories = ({ setFilteredItems, setFilteredTime, searchIds }) => {

  const [selectedGender, setSelectedGender] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedSubCategory, setSelectedSubCategory] = useState('');
  const [selectedColor, setSelectedColor] = useState('');
  const [selectedUsage, setSelectedUsage] = useState('');

  // Main filter function
  const filterItems = async (overrides = {}) => {
    try {
      const startTime = performance.now();

      const bodyData = { ids: searchIds };
      const query = new URLSearchParams();

      // Merge current state with overrides for immediate updates
      const gender = overrides.gender !== undefined ? overrides.gender : selectedGender;
      const category = overrides.category !== undefined ? overrides.category : selectedCategory;
      const subCategory = overrides.subCategory !== undefined ? overrides.subCategory : selectedSubCategory;
      const color = overrides.color !== undefined ? overrides.color : selectedColor;
      const usage = overrides.usage !== undefined ? overrides.usage : selectedUsage;

      if (gender) query.append('gender', gender);
      if (category) query.append('category', category);
      if (subCategory) query.append('subcategory', subCategory);
      if (color) query.append('color', color);
      if (usage) query.append('usage', usage);

      const { data } = await axios.post(
        `http://localhost:5000/products/filter-products?${query.toString()}`,
        bodyData
      );

      const endTime = performance.now();
      setFilteredTime((endTime - startTime).toFixed(2));
      setFilteredItems(data.message);
    } catch (error) {
      console.error('Error sending request:', error.message);
    }
  };

  // Render checkboxes for a filter
  const renderCheckboxList = (options, selected, setSelected, type) => {
    return options.map(option => (
      <li key={option} className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={selected === option}
          onChange={() => {
            const newValue = selected === option ? '' : option;
            setSelected(newValue);
            filterItems({ [type]: newValue }); // Call filter immediately with latest selection
          }}
        />
        {option}
      </li>
    ));
  };

  return (
    <div className="w-80 flex gap-6 flex-col px-4 h-full pt-4">
      {/* GENDER */}
      <div className="flex flex-col w-full gap-3">
        <h1 className="text-gray-600 font-bold text-lg">GENDER</h1>
        <ul>
          {renderCheckboxList(['Boys', 'Girls', 'Men', 'Women', 'Unisex'], selectedGender, setSelectedGender, 'gender')}
        </ul>
      </div>

      {/* CATEGORY */}
      <div className="flex flex-col w-full gap-3">
        <h1 className="text-gray-600 font-bold text-lg">CATEGORY</h1>
        <ul>
          {renderCheckboxList(['Apparel', 'Accessories', 'Footwear', 'Personal Care', 'Free Items', 'Sporting Goods', 'Home'], selectedCategory, setSelectedCategory, 'category')}
        </ul>
      </div>

      {/* SUBCATEGORY */}
      <div className="flex flex-col w-full gap-3">
        <h1 className="text-gray-600 font-bold text-lg">SUB CATEGORY</h1>
        <ul>
          {renderCheckboxList(['Topwear', 'Shoes', 'Bags', 'Bottomwear', 'Watches', 'Innerwear', 'Jewellery', 'Eyewear', 'Fragrance', 'Sandal'], selectedSubCategory, setSelectedSubCategory, 'subCategory')}
        </ul>
      </div>

      {/* COLOR */}
      <div className="flex flex-col w-full gap-3">
        <h1 className="text-gray-600 font-bold text-lg">COLOR</h1>
        <ul>
          {renderCheckboxList(['Brown', 'Blue', 'Black', 'Green', 'Red', 'Grey', 'White'], selectedColor, setSelectedColor, 'color')}
        </ul>
      </div>

      {/* USAGE */}
      <div className="flex flex-col w-full gap-3">
        <h1 className="text-gray-600 font-bold text-lg">USAGE</h1>
        <ul>
          {renderCheckboxList(['Casual', 'Sports', 'Ethnic', 'Formal', 'Party', 'Travel'], selectedUsage, setSelectedUsage, 'usage')}
        </ul>
      </div>

      {/* Manual Filter Button */}
      <button className="mt-4 bg-blue-500 text-white py-2 px-4 rounded" onClick={() => filterItems()}>
        Filter
      </button>
    </div>
  );
};

export default Categories;
