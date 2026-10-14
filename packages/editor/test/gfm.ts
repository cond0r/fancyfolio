import { gfmFootnoteFromMarkdown } from 'mdast-util-gfm-footnote';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import rehypeStringify from 'rehype-stringify';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { type Processor, unified } from 'unified';

function commonMarkGfm(this: Processor) {
  const data = this.data();
  data.micromarkExtensions = [gfmFootnote(), gfmStrikethrough(), gfmTable(), gfmTaskListItem()];
  data.fromMarkdownExtensions = [
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  ];
}

export const gfmHtml = unified()
  .use(remarkParse)
  .use(commonMarkGfm)
  .use(remarkRehype)
  .use(rehypeStringify);
