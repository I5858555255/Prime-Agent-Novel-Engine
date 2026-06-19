use std::error::Error;
use std::fmt;

const DEFAULT_ORIENTATION: u8 = 1;
const EXIF_HEADER: &[u8; 6] = b"Exif\0\0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbaImage {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbaImageError {
    pub width: usize,
    pub height: usize,
    pub len: usize,
}

impl fmt::Display for RgbaImageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid RGBA buffer length {} for {}x{} image",
            self.len, self.width, self.height
        )
    }
}

impl Error for RgbaImageError {}

impl RgbaImage {
    pub fn new(width: usize, height: usize, pixels: Vec<u8>) -> Result<Self, RgbaImageError> {
        let expected_len = rgba_len(width, height);
        if expected_len != Some(pixels.len()) {
            return Err(RgbaImageError {
                width,
                height,
                len: pixels.len(),
            });
        }

        Ok(Self {
            width,
            height,
            pixels,
        })
    }
}

pub fn get_exif_orientation(bytes: &[u8]) -> u8 {
    let tiff_offset = if is_jpeg(bytes) {
        find_jpeg_tiff_offset(bytes)
    } else if is_webp(bytes) {
        find_webp_tiff_offset(bytes)
    } else {
        None
    };

    tiff_offset
        .map(|offset| read_orientation_from_tiff(bytes, offset))
        .unwrap_or(DEFAULT_ORIENTATION)
}

pub fn read_orientation_from_tiff(bytes: &[u8], tiff_start: usize) -> u8 {
    if tiff_start
        .checked_add(8)
        .is_none_or(|end| end > bytes.len())
    {
        return DEFAULT_ORIENTATION;
    }

    let little_endian = read_u16_be(bytes, tiff_start) == Some(0x4949);
    let Some(ifd_offset) = read_u32(bytes, tiff_start + 4, little_endian) else {
        return DEFAULT_ORIENTATION;
    };
    let Some(ifd_start) = tiff_start.checked_add(ifd_offset as usize) else {
        return DEFAULT_ORIENTATION;
    };

    if ifd_start.checked_add(2).is_none_or(|end| end > bytes.len()) {
        return DEFAULT_ORIENTATION;
    }

    let Some(entry_count) = read_u16(bytes, ifd_start, little_endian) else {
        return DEFAULT_ORIENTATION;
    };

    for index in 0..entry_count as usize {
        let Some(entry_pos) = ifd_start
            .checked_add(2)
            .and_then(|pos| pos.checked_add(index.checked_mul(12)?))
        else {
            return DEFAULT_ORIENTATION;
        };

        if entry_pos
            .checked_add(12)
            .is_none_or(|end| end > bytes.len())
        {
            return DEFAULT_ORIENTATION;
        }

        if read_u16(bytes, entry_pos, little_endian) == Some(0x0112) {
            let value = read_u16(bytes, entry_pos + 8, little_endian).unwrap_or(0) as u8;
            return if (1..=8).contains(&value) {
                value
            } else {
                DEFAULT_ORIENTATION
            };
        }
    }

    DEFAULT_ORIENTATION
}

pub fn apply_exif_orientation_rgba(
    image: &RgbaImage,
    orientation: u8,
) -> Result<RgbaImage, RgbaImageError> {
    validate_rgba_image(image)?;

    let (dst_width, dst_height) = match orientation {
        5..=8 => (image.height, image.width),
        _ => (image.width, image.height),
    };
    let mut dst = vec![0; image.pixels.len()];

    for y in 0..image.height {
        for x in 0..image.width {
            let (dst_x, dst_y) = oriented_position(x, y, image.width, image.height, orientation);
            let src_idx = (y * image.width + x) * 4;
            let dst_idx = (dst_y * dst_width + dst_x) * 4;
            dst[dst_idx..dst_idx + 4].copy_from_slice(&image.pixels[src_idx..src_idx + 4]);
        }
    }

    RgbaImage::new(dst_width, dst_height, dst)
}

pub fn apply_exif_orientation_from_bytes_rgba(
    image: &RgbaImage,
    original_bytes: &[u8],
) -> Result<RgbaImage, RgbaImageError> {
    apply_exif_orientation_rgba(image, get_exif_orientation(original_bytes))
}

fn oriented_position(
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    orientation: u8,
) -> (usize, usize) {
    match orientation {
        2 => (width - 1 - x, y),
        3 => (width - 1 - x, height - 1 - y),
        4 => (x, height - 1 - y),
        5 => (y, x),
        6 => (height - 1 - y, x),
        7 => (height - 1 - y, width - 1 - x),
        8 => (y, width - 1 - x),
        _ => (x, y),
    }
}

fn find_jpeg_tiff_offset(bytes: &[u8]) -> Option<usize> {
    let mut offset = 2;
    while offset + 1 < bytes.len() {
        if bytes[offset] != 0xff {
            return None;
        }

        let marker = bytes[offset + 1];
        if marker == 0xff {
            offset += 1;
            continue;
        }

        if marker == 0xe1 {
            if offset + 4 >= bytes.len() {
                return None;
            }

            let segment_start = offset + 4;
            if segment_start + EXIF_HEADER.len() > bytes.len() {
                return None;
            }

            return has_exif_header(bytes, segment_start)
                .then_some(segment_start + EXIF_HEADER.len());
        }

        if offset + 4 > bytes.len() {
            return None;
        }

        let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
        offset = offset.checked_add(2 + length)?;
    }

    None
}

fn find_webp_tiff_offset(bytes: &[u8]) -> Option<usize> {
    let mut offset: usize = 12;
    while offset.checked_add(8).is_some_and(|end| end <= bytes.len()) {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        let data_start = offset + 8;

        if chunk_id == b"EXIF" {
            if data_start
                .checked_add(chunk_size)
                .is_none_or(|end| end > bytes.len())
            {
                return None;
            }

            let tiff_start =
                if chunk_size >= EXIF_HEADER.len() && has_exif_header(bytes, data_start) {
                    data_start + EXIF_HEADER.len()
                } else {
                    data_start
                };
            return Some(tiff_start);
        }

        offset = data_start
            .checked_add(chunk_size)?
            .checked_add(chunk_size % 2)?;
    }

    None
}

fn has_exif_header(bytes: &[u8], offset: usize) -> bool {
    let Some(end) = offset.checked_add(EXIF_HEADER.len()) else {
        return false;
    };

    bytes
        .get(offset..end)
        .is_some_and(|header| header == EXIF_HEADER)
}

fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] == 0xd8
}

fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

fn read_u16(bytes: &[u8], pos: usize, little_endian: bool) -> Option<u16> {
    let raw = [*bytes.get(pos)?, *bytes.get(pos + 1)?];
    Some(if little_endian {
        u16::from_le_bytes(raw)
    } else {
        u16::from_be_bytes(raw)
    })
}

fn read_u16_be(bytes: &[u8], pos: usize) -> Option<u16> {
    let raw = [*bytes.get(pos)?, *bytes.get(pos + 1)?];
    Some(u16::from_be_bytes(raw))
}

fn read_u32(bytes: &[u8], pos: usize, little_endian: bool) -> Option<u32> {
    let raw = [
        *bytes.get(pos)?,
        *bytes.get(pos + 1)?,
        *bytes.get(pos + 2)?,
        *bytes.get(pos + 3)?,
    ];
    Some(if little_endian {
        u32::from_le_bytes(raw)
    } else {
        u32::from_be_bytes(raw)
    })
}

fn rgba_len(width: usize, height: usize) -> Option<usize> {
    width.checked_mul(height)?.checked_mul(4)
}

fn validate_rgba_image(image: &RgbaImage) -> Result<(), RgbaImageError> {
    if rgba_len(image.width, image.height) == Some(image.pixels.len()) {
        Ok(())
    } else {
        Err(RgbaImageError {
            width: image.width,
            height: image.height,
            len: image.pixels.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exif_orientation_reads_little_endian_tiff_orientation() {
        let tiff = tiff_with_orientation(6, true);

        assert_eq!(read_orientation_from_tiff(&tiff, 0), 6);
    }

    #[test]
    fn exif_orientation_reads_big_endian_tiff_orientation() {
        let tiff = tiff_with_orientation(8, false);

        assert_eq!(read_orientation_from_tiff(&tiff, 0), 8);
    }

    #[test]
    fn exif_orientation_reads_jpeg_app1_orientation() {
        let tiff = tiff_with_orientation(3, true);
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1];
        let segment_len = (EXIF_HEADER.len() + tiff.len() + 2) as u16;
        jpeg.extend_from_slice(&segment_len.to_be_bytes());
        jpeg.extend_from_slice(EXIF_HEADER);
        jpeg.extend_from_slice(&tiff);

        assert_eq!(get_exif_orientation(&jpeg), 3);
    }

    #[test]
    fn exif_orientation_reads_webp_exif_orientation() {
        let tiff = tiff_with_orientation(5, true);
        let mut chunk_data = EXIF_HEADER.to_vec();
        chunk_data.extend_from_slice(&tiff);

        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&(4 + 8 + chunk_data.len() as u32).to_le_bytes());
        webp.extend_from_slice(b"WEBP");
        webp.extend_from_slice(b"EXIF");
        webp.extend_from_slice(&(chunk_data.len() as u32).to_le_bytes());
        webp.extend_from_slice(&chunk_data);
        if chunk_data.len() % 2 == 1 {
            webp.push(0);
        }

        assert_eq!(get_exif_orientation(&webp), 5);
    }

    #[test]
    fn exif_orientation_defaults_to_one_for_invalid_values() {
        let tiff = tiff_with_orientation(9, true);

        assert_eq!(read_orientation_from_tiff(&tiff, 0), 1);
        assert_eq!(get_exif_orientation(b"not an image"), 1);
    }

    #[test]
    fn exif_orientation_applies_all_rgba_rotation_and_flip_indices() {
        let image = numbered_image(2, 3, &[1, 2, 3, 4, 5, 6]);

        let cases = [
            (1, 2, 3, vec![1, 2, 3, 4, 5, 6]),
            (2, 2, 3, vec![2, 1, 4, 3, 6, 5]),
            (3, 2, 3, vec![6, 5, 4, 3, 2, 1]),
            (4, 2, 3, vec![5, 6, 3, 4, 1, 2]),
            (5, 3, 2, vec![1, 3, 5, 2, 4, 6]),
            (6, 3, 2, vec![5, 3, 1, 6, 4, 2]),
            (7, 3, 2, vec![6, 4, 2, 5, 3, 1]),
            (8, 3, 2, vec![2, 4, 6, 1, 3, 5]),
        ];

        for (orientation, width, height, ids) in cases {
            let transformed = apply_exif_orientation_rgba(&image, orientation).unwrap();
            assert_eq!(transformed.width, width, "orientation {orientation}");
            assert_eq!(transformed.height, height, "orientation {orientation}");
            assert_eq!(pixel_ids(&transformed), ids, "orientation {orientation}");
        }
    }

    #[test]
    fn exif_orientation_rejects_invalid_rgba_buffer_lengths() {
        let image = RgbaImage {
            width: 2,
            height: 2,
            pixels: vec![0; 15],
        };

        assert_eq!(
            apply_exif_orientation_rgba(&image, 1),
            Err(RgbaImageError {
                width: 2,
                height: 2,
                len: 15,
            })
        );
    }

    fn tiff_with_orientation(orientation: u16, little_endian: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        if little_endian {
            bytes.extend_from_slice(b"II");
            bytes.extend_from_slice(&42u16.to_le_bytes());
            bytes.extend_from_slice(&8u32.to_le_bytes());
            bytes.extend_from_slice(&1u16.to_le_bytes());
            bytes.extend_from_slice(&0x0112u16.to_le_bytes());
            bytes.extend_from_slice(&3u16.to_le_bytes());
            bytes.extend_from_slice(&1u32.to_le_bytes());
            bytes.extend_from_slice(&orientation.to_le_bytes());
            bytes.extend_from_slice(&0u16.to_le_bytes());
        } else {
            bytes.extend_from_slice(b"MM");
            bytes.extend_from_slice(&42u16.to_be_bytes());
            bytes.extend_from_slice(&8u32.to_be_bytes());
            bytes.extend_from_slice(&1u16.to_be_bytes());
            bytes.extend_from_slice(&0x0112u16.to_be_bytes());
            bytes.extend_from_slice(&3u16.to_be_bytes());
            bytes.extend_from_slice(&1u32.to_be_bytes());
            bytes.extend_from_slice(&orientation.to_be_bytes());
            bytes.extend_from_slice(&0u16.to_be_bytes());
        }
        bytes
    }

    fn numbered_image(width: usize, height: usize, ids: &[u8]) -> RgbaImage {
        let pixels = ids
            .iter()
            .flat_map(|id| [*id, 0, 0, 255])
            .collect::<Vec<_>>();
        RgbaImage::new(width, height, pixels).unwrap()
    }

    fn pixel_ids(image: &RgbaImage) -> Vec<u8> {
        image.pixels.chunks_exact(4).map(|pixel| pixel[0]).collect()
    }
}
