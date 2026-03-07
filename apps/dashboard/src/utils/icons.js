const config = {

}

const rawIcons = {

}

export const generateIcon = (name, size, color = '#000', style = {}, isRaw = false) => {
    // Handle null/undefined name
    if (!name) {
        return null;
    }

    if(isRaw) {
        return <img src={name?.replace(/ /g, '%20')} alt={name} style={{
            width: size,
            height: size,
            objectFit: 'contain',
            ...style
        }} />
    }

    let url = `https://cdn.oblien.com/static/png-icons/${config[name]?.replace(/ /g, '%20') || name?.replace(/ /g, '%20')}`
    
    if(name.startsWith('http')) {
        url = name
    }

    return <div style={{
        maskImage: `url('${url}')`,
        maskSize: 'contain',
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        width: size,
        height: size,
        backgroundColor: color,
        ...style
    }} />
}


export default generateIcon