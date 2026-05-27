import { MenuItem } from './components/MenuTree';

export interface TreeItem extends MenuItem {
  children?: TreeItem[];
  expanded?: boolean;
}

/**
 * Converts a flat list of Drupal menu items (ordered by weight/appearance)
 * into a nested tree structure based on their depth.
 */
export function flatToTree(items: MenuItem[]): TreeItem[] {
  const root: TreeItem[] = [];
  const stack: TreeItem[] = [];

  items.forEach(item => {
    const node: TreeItem = { ...item, children: [], expanded: true };

    while (stack.length > node.depth) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(node);
    } else {
      const parent = stack[stack.length - 1];
      parent.children = parent.children || [];
      parent.children.push(node);
    }

    stack.push(node);
  });

  return root;
}

/**
 * Flattens a tree structure back into a flat list with depth and weight.
 */
export function treeToFlat(tree: TreeItem[], depth = 0): MenuItem[] {
  let flat: MenuItem[] = [];
  
  tree.forEach((node) => {
    const { children, expanded, ...item } = node;
    flat.push({ ...item, depth });
    if (children && children.length > 0) {
      flat = flat.concat(treeToFlat(children, depth + 1));
    }
  });

  return flat;
}
