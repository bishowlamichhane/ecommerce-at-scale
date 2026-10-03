import { Grid } from "react-window"; 
import { useRef, useEffect, useState } from "react"; 
import axios from "axios"; 

const Hero = ({ items, duration, onLoadMore }) => { 
  const containerRef = useRef(null); 
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 }); 

  const columnCount = 4; 
  const rowCount = Math.ceil((items?.length || 0) / columnCount); 

  const CARD_HEIGHT = 320; 
  const GAP = 16; 
  const rowHeight = CARD_HEIGHT + GAP; 

  const OUTER_PADDING = 32; 
  const TOTAL_HORIZONTAL_GAP = (columnCount - 1) * (GAP / 2); 

  const columnWidth = 
    dimensions.width > 0 
      ? Math.floor((dimensions.width - OUTER_PADDING - TOTAL_HORIZONTAL_GAP) / columnCount) 
      : 210; 

  const totalColumnWidth = columnWidth + (GAP / 2); 

  useEffect(() => { 
    const updateDimensions = () => { 
      if (containerRef.current) { 
        const rect = containerRef.current.getBoundingClientRect(); 
        setDimensions({ width: rect.width, height: rect.height }); 
      } 
    }; 

    updateDimensions(); 
    window.addEventListener('resize', updateDimensions); 

    let resizeObserver; 
    if (containerRef.current && window.ResizeObserver) { 
      resizeObserver = new ResizeObserver(updateDimensions); 
      resizeObserver.observe(containerRef.current); 
    } 

    return () => { 
      window.removeEventListener('resize', updateDimensions); 
      if (resizeObserver) { 
        resizeObserver.disconnect(); 
      } 
    }; 
  }, [items]); 

  const addToCart = async (itemId) => { 
    let bodyItem = { productId: itemId, quantity: 2 } 
    const { data } = await axios.post(`http://localhost:5000/cart/add-to-cart`, bodyItem); 
    console.log(data.message); 
  } 

  const Cell = ({ columnIndex, rowIndex, style }) => { 
    const index = rowIndex * columnCount + columnIndex; 
    if (index >= items.length) return null; 

    const item = items[index]; 
    const cellStyle = { ...style }; 

    cellStyle.marginRight = columnIndex < columnCount - 1 ? `${GAP / 2}px` : 0; 
    cellStyle.marginBottom = `${GAP / 2}px`; 
    cellStyle.width = columnWidth; 

    const itemId = item?._id || ""; 
    const name = item?.name || 'Unknown Product'; 
    const color = item?.color || 'N/A'; 
    const price = item?.price !== undefined ? item.price : 'N/A'; 
    const image = item?.image || 'placeholder.png'; 

    return ( 
      <div style={cellStyle} className="flex h-full w-full" > 
        <div className="border flex gap-2 flex-col p-2 product-card box-border w-full h-full"> 
          <div className="w-full h-40 border-b overflow-hidden"> 
            <img 
              src={image} 
              className="object-contain object-center w-full h-full" 
              alt={name} 
            /> 
          </div> 

          <div className={`text-${color?.toLowerCase()}-700 text-sm`}> 
            {color} 
          </div> 

          <div className="text-md">{name}</div> 

          <div className="text-md flex gap-2 items-center"> 
            <span className="text-gray-400">$</span> {price} 
          </div> 

          <div> 
            <button onClick={() => addToCart(itemId)}>Add to Cart</button>
          </div> 
        </div> 
      </div> 
    ); 
  }; 

  if (!items || items.length === 0) { 
    return ( 
      <div className="flex-1 flex flex-col pt-4 px-4"> 
        <div className="flex justify-between items-center pt-4"> 
          <p>No results found</p> 
        </div> 
      </div> 
    ); 
  } 

  return ( 
    <div className="flex-1 flex flex-col pt-4 px-4 overflow-hidden"> 
      <div className="flex justify-between items-center pt-4 mb-4 flex-shrink-0"> 
        <p>{items.length} results found in {duration} ms</p> 

        <div className="w-40 h-12 border-1 flex items-center justify-center rounded-md"> 
          <select> 
            <option selected>Featured</option> 
            <option>Price: High to Low</option> 
            <option>Price: Low to High</option> 
          </select> 
        </div> 
      </div> 

      <div ref={containerRef} className="flex-1 w-full overflow-hidden" style={{ minHeight: 0 }} > 
        {dimensions.width > 0 && dimensions.height > 0 && ( 
         <Grid
         columnCount={4}
         rowCount={Math.ceil(items?.length / 4)}
         columnWidth={columnWidth}
         rowHeight={rowHeight}
         cellComponent={Cell}
         cellProps={{}} 
         onScroll={({ scrollTop, scrollHeight, clientHeight }) => {
           if (scrollTop + clientHeight >= scrollHeight - 100) {
             onLoadMore();
             console.log("End")
           }
         }}
       />
        )} 
      </div> 

     
    </div> 
  ); 
}; 

export default Hero;
