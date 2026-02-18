#!/usr/bin/env python3
import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

NS = {
    'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'rel': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'pkgrel': 'http://schemas.openxmlformats.org/package/2006/relationships'
}

DATE_BUILTIN_IDS = set(list(range(14, 23)) + [45, 46, 47])

def col_to_index(col):
    value = 0
    for c in col:
        value = value * 26 + (ord(c) - ord('A') + 1)
    return value - 1

def excel_date_to_iso(serial):
    base = datetime(1899, 12, 30)
    dt = base + timedelta(days=float(serial))
    return dt.isoformat()

def load_shared_strings(zf):
    path = 'xl/sharedStrings.xml'
    if path not in zf.namelist():
        return []
    root = ET.fromstring(zf.read(path))
    result = []
    for si in root.findall('main:si', NS):
        texts = [t.text or '' for t in si.findall('.//main:t', NS)]
        result.append(''.join(texts))
    return result

def load_date_styles(zf):
    path = 'xl/styles.xml'
    if path not in zf.namelist():
        return set()
    root = ET.fromstring(zf.read(path))

    custom_formats = {}
    numfmts = root.find('main:numFmts', NS)
    if numfmts is not None:
        for fmt in numfmts.findall('main:numFmt', NS):
            fmt_id = int(fmt.attrib.get('numFmtId', '0'))
            code = (fmt.attrib.get('formatCode') or '').lower()
            custom_formats[fmt_id] = code

    date_xfs = set()
    cellxfs = root.find('main:cellXfs', NS)
    if cellxfs is None:
        return date_xfs

    for idx, xf in enumerate(cellxfs.findall('main:xf', NS)):
        num_fmt_id = int(xf.attrib.get('numFmtId', '0'))
        if num_fmt_id in DATE_BUILTIN_IDS:
            date_xfs.add(idx)
            continue
        code = custom_formats.get(num_fmt_id, '')
        if code and any(ch in code for ch in ['yy', 'dd', 'mm', 'hh', 'ss']) and '0' not in code:
            date_xfs.add(idx)
    return date_xfs

def first_sheet_path(zf):
    workbook = ET.fromstring(zf.read('xl/workbook.xml'))
    sheets = workbook.find('main:sheets', NS)
    first = sheets.find('main:sheet', NS)
    rel_id = first.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']

    rels = ET.fromstring(zf.read('xl/_rels/workbook.xml.rels'))
    target = None
    for rel in rels.findall('pkgrel:Relationship', NS):
        if rel.attrib.get('Id') == rel_id:
            target = rel.attrib.get('Target')
            break
    if not target:
        raise RuntimeError('Sheet relationship not found')
    if target.startswith('/'):
        return target[1:]
    if target.startswith('xl/'):
        return target
    return 'xl/' + target

def parse_sheet_rows(zf, sheet_path, shared_strings, date_xfs):
    root = ET.fromstring(zf.read(sheet_path))
    data = []
    for row in root.findall('.//main:sheetData/main:row', NS):
        values = {}
        max_col = -1
        for cell in row.findall('main:c', NS):
            ref = cell.attrib.get('r', '')
            col_letters = ''.join(ch for ch in ref if ch.isalpha())
            if not col_letters:
                continue
            col_idx = col_to_index(col_letters)
            max_col = max(max_col, col_idx)

            cell_type = cell.attrib.get('t')
            style_id = int(cell.attrib.get('s', '0'))
            value_node = cell.find('main:v', NS)
            inline_node = cell.find('main:is/main:t', NS)

            if inline_node is not None:
                value = inline_node.text or ''
            elif value_node is None:
                value = ''
            else:
                raw = value_node.text or ''
                if cell_type == 's':
                    idx = int(raw) if raw else 0
                    value = shared_strings[idx] if 0 <= idx < len(shared_strings) else ''
                elif cell_type == 'b':
                    value = raw == '1'
                elif style_id in date_xfs and raw != '':
                    value = excel_date_to_iso(raw)
                else:
                    try:
                        number = float(raw)
                        value = int(number) if number.is_integer() else number
                    except ValueError:
                        value = raw

            values[col_idx] = value

        row_list = [values.get(i, '') for i in range(max_col + 1)] if max_col >= 0 else []
        data.append(row_list)
    return data

def rows_to_objects(rows):
    if not rows:
        return []
    headers = [str(h).strip() for h in rows[0]]
    result = []
    for row in rows[1:]:
        obj = {}
        for i, header in enumerate(headers):
            if not header:
                continue
            obj[header] = row[i] if i < len(row) else ''
        if any(str(v).strip() for v in obj.values()):
            result.append(obj)
    return result

def main():
    if len(sys.argv) < 2:
        print('Usage: parse_xlsx.py <xlsx-path> [mode]', file=sys.stderr)
        sys.exit(1)

    xlsx_path = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else 'objects'

    with zipfile.ZipFile(xlsx_path, 'r') as zf:
        shared_strings = load_shared_strings(zf)
        date_xfs = load_date_styles(zf)
        sheet_path = first_sheet_path(zf)
        rows = parse_sheet_rows(zf, sheet_path, shared_strings, date_xfs)

    payload = rows if mode == 'arrays' else rows_to_objects(rows)
    print(json.dumps(payload, ensure_ascii=False))

if __name__ == '__main__':
    main()
